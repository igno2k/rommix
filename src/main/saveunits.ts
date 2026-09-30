import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SaveUnit } from '@config/emulators'
import { t } from './i18n.ts'
import { log } from './log.ts'
import { backupPath, keepBackup, stampMtime, walk } from './savefiles.ts'
import { extractZip } from './zip.ts'

/**
 * One game's entries in a folder every game writes to: finding them, and
 * replacing them with the copy a pull brought down.
 *
 * The rule of this file is the one the whole shape exists for: nothing that is
 * not the game's is read for an upload, and nothing that is not the game's is
 * created, replaced or removed by a pull. The descriptor's `SaveUnit.owns`
 * decides what is the game's, and it is asked of the disk and of the archive
 * alike — an archive carrying anything it does not claim is refused whole
 * rather than partly unpacked.
 *
 * A pull is verify, back up, stage, swap. Every member about to be replaced or
 * removed is copied aside first, one copy per member, and the pull stops before
 * touching anything if a copy could not be taken. The archive is unpacked next
 * to the folder rather than into it, so a half-written entry is never where an
 * emulator can see it, and each member is moved into place by renames on one
 * filesystem: the old one aside, the new one in, the old one back if the second
 * rename fails.
 */

/** What of a unit is on this disk. */
export interface UnitOnDisk {
  /** Names of the owned entries directly inside the location's `dir`, sorted. */
  members: string[]
  /** Newest mtime of any file under them; 0 when there is none. */
  newest: number
}

/** The directory entries of `dir` with their kind, symlinks as what they point at. */
async function entriesOf(dir: string): Promise<{ name: string; kind: 'file' | 'dir' }[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: { name: string; kind: 'file' | 'dir' }[] = []
  for (const entry of entries) {
    let isDirectory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      isDirectory = await stat(join(dir, entry.name))
        .then((info) => info.isDirectory())
        .catch(() => false)
    }
    found.push({ name: entry.name, kind: isDirectory ? 'dir' : 'file' })
  }
  return found
}

/** Is this an entry the rule may claim at all? Its hands-off list never is. */
function claimable(unit: SaveUnit, name: string): boolean {
  return !(unit.keepsHandsOff ?? []).includes(name)
}

/** The owned entries of `dir`, as the rule judges them there. */
async function ownedIn(
  unit: SaveUnit,
  dir: string
): Promise<{ name: string; kind: 'file' | 'dir' }[]> {
  return (await entriesOf(dir))
    .filter((entry) => claimable(unit, entry.name) && unit.owns(entry.name, entry.kind, dir))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Newest mtime under one entry, file or folder. */
async function newestOf(path: string, kind: 'file' | 'dir'): Promise<number> {
  const files = kind === 'dir' ? await walk(path) : [path]
  let latest = 0
  for (const file of files) {
    latest = Math.max(latest, (await stat(file).catch(() => null))?.mtimeMs ?? 0)
  }
  return latest
}

/** The game's entries in `dir`, and how new the newest of them is. */
export async function findUnit(dir: string, unit: SaveUnit): Promise<UnitOnDisk> {
  const owned = await ownedIn(unit, dir)
  let newest = 0
  for (const entry of owned)
    newest = Math.max(newest, await newestOf(join(dir, entry.name), entry.kind))
  return { members: owned.map((entry) => entry.name), newest }
}

/**
 * Which entries of an unpacked archive are to be moved into the folder, and
 * from where.
 *
 * Every root has to be the game's. One exception is taken, because another
 * client once wrote it: a single folder that is not itself the game's but holds
 * the game's entries — a whole card, with the game's saves inside — is read one
 * level down, and only the owned entries in it are taken. Anything beside them
 * in that folder is another game's and is left out rather than refused, since
 * the folder was never going to be written anywhere.
 *
 * Null means refused: something here is not the game's, or nothing is.
 */
async function acceptedRoots(
  unit: SaveUnit,
  staged: string
): Promise<{ from: string; names: string[] } | null> {
  const roots = await entriesOf(staged)
  if (roots.length === 0) return null
  if (roots.some((root) => !claimable(unit, root.name))) return null

  const owned = roots.filter((root) => unit.owns(root.name, root.kind, staged))
  if (owned.length === roots.length) return { from: staged, names: owned.map((root) => root.name) }

  if (roots.length === 1 && roots[0].kind === 'dir') {
    const inner = join(staged, roots[0].name)
    const names = (await ownedIn(unit, inner)).map((entry) => entry.name)
    if (names.length > 0) return { from: inner, names }
  }
  return null
}

/**
 * Where a pull stages its work: beside the shared folder, on its filesystem.
 *
 * Beside rather than inside, because inside is where the emulator lists its
 * saves — a staging folder in a PCSX2 card is a save folder PCSX2 would show.
 * Resolved through any link first, so the renames that follow stay on the one
 * filesystem the folder is really on.
 */
async function stagingFor(dir: string, romId: number): Promise<{ staging: string; aside: string }> {
  const real = await realpath(dir).catch(() => dir)
  const base = join(dirname(real), `.rommix-unit-${romId}-${basename(real)}`)
  return { staging: `${base}.part`, aside: `${base}.old` }
}

/** Copy one member aside, and say whether the copy is really there. */
async function backedUp(path: string, backups: string, kind: 'file' | 'dir'): Promise<boolean> {
  try {
    await keepBackup(path, backups, kind === 'dir')
  } catch (cause) {
    log.warn('saves', 'could not copy a member of a shared save folder aside', {
      path,
      backups,
      reason: (cause as Error).message
    })
    return false
  }
  return (await stat(backupPath(backups, path, 1)).catch(() => null)) !== null
}

/**
 * Replace the game's entries in `dir` with the ones in the archive at
 * `archive`, which the caller has already downloaded and verified.
 *
 * Members here that the archive does not carry are removed too — after their
 * copy is taken — because the archive is the unit: a save deleted on another
 * device stays deleted, as it does under Argosy. That is the one thing a pull
 * of a unit removes, and it is logged by name.
 *
 * Returns the names written. Throws, having changed nothing, when the archive is
 * refused or a member could not be copied aside.
 */
export async function restoreUnit(options: {
  dir: string
  unit: SaveUnit
  archive: string
  backups: string
  remoteTime: number
  romId: number
}): Promise<string[]> {
  const { dir, unit, archive, backups, remoteTime, romId } = options
  await mkdir(dir, { recursive: true })
  const { staging, aside } = await stagingFor(dir, romId)
  await rm(staging, { recursive: true, force: true })
  await rm(aside, { recursive: true, force: true })

  try {
    await extractZip(archive, staging)
    const accepted = await acceptedRoots(unit, staging)
    if (!accepted) {
      log.error('saves', 'refused an archive holding entries that are not this game’s', undefined, {
        romId,
        key: unit.key,
        dir,
        roots: (await entriesOf(staging)).map((root) => root.name)
      })
      throw new Error(t('error.unitRefused', { name: unit.key }))
    }

    const incoming = new Set(accepted.names)
    const local = await ownedIn(unit, dir)
    const leaving = local.filter((entry) => !incoming.has(entry.name))

    // Every copy first, so a member that cannot be kept stops the pull before
    // anything has changed.
    for (const entry of local) {
      if (!(await backedUp(join(dir, entry.name), backups, entry.kind))) {
        throw new Error(t('error.unitNoBackup', { name: entry.name }))
      }
    }

    await mkdir(aside, { recursive: true })
    for (const name of accepted.names) {
      const target = join(dir, name)
      const old = join(aside, name)
      const had = local.some((entry) => entry.name === name)
      if (had) await rename(target, old)
      try {
        await rename(join(accepted.from, name), target)
      } catch (cause) {
        if (had) await rename(old, target)
        log.error('saves', 'could not move a pulled entry into place, the old one is back', cause, {
          romId,
          member: name,
          dir
        })
        throw cause
      }
      const kind = (await stat(target)).isDirectory() ? 'dir' : 'file'
      for (const file of kind === 'dir' ? await walk(target) : [])
        await stampMtime(file, remoteTime)
      await stampMtime(target, remoteTime)
    }
    for (const entry of leaving) {
      await rename(join(dir, entry.name), join(aside, entry.name))
      log.info('saves', 'removed an entry the pulled copy of this game no longer has', {
        romId,
        member: entry.name,
        dir
      })
    }

    log.info('saves', 'replaced this game’s entries in a shared save folder', {
      romId,
      key: unit.key,
      dir,
      wrote: accepted.names,
      removed: leaving.map((entry) => entry.name)
    })
    return accepted.names
  } finally {
    await rm(staging, { recursive: true, force: true }).catch((cause: unknown) =>
      log.warn('saves', 'could not remove a pull’s staging folder', {
        staging,
        reason: (cause as Error).message
      })
    )
    await rm(aside, { recursive: true, force: true }).catch((cause: unknown) =>
      log.warn('saves', 'could not remove the entries a pull replaced', {
        aside,
        reason: (cause as Error).message
      })
    )
  }
}

/**
 * Remove the game's entries from `dir`, each copied aside first — what
 * deleting "this game's save on this device" means for a unit. Nothing else in
 * the folder is touched.
 */
export async function removeUnit(dir: string, unit: SaveUnit, backups: string): Promise<string[]> {
  const owned = await ownedIn(unit, dir)
  for (const entry of owned) {
    if (!(await backedUp(join(dir, entry.name), backups, entry.kind))) {
      throw new Error(t('error.unitNoBackup', { name: entry.name }))
    }
  }
  for (const entry of owned) await rm(join(dir, entry.name), { recursive: true, force: true })
  return owned.map((entry) => entry.name)
}
