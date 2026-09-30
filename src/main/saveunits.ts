import { copyFile, link, lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { SaveUnit } from '@config/emulators'
import { t } from './i18n.ts'
import { log } from './log.ts'
import { backupPath, keepBackup, stampMtime, walk } from './savefiles.ts'
import { extractZip, SAVE_ARCHIVE_MAX_BYTES, zipRoots } from './zip.ts'

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
  /** Those of `members` another game owns too (`SaveUnit.shares`), sorted. */
  shared: string[]
  /**
   * Newest mtime of any file under the members that are the game's alone; 0
   * when there is none. A shared entry moves when the other game is played.
   */
  newest: number
}

/** Does another game own this entry too? */
function isShared(unit: SaveUnit, name: string): boolean {
  return unit.shares?.(name) ?? false
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

/** Is this file inside a member the emulator's rather than the save's? */
function ignored(unit: SaveUnit, file: string): boolean {
  return (unit.ignoresInside ?? []).includes(basename(file))
}

/** Newest mtime under one entry, file or folder, minus what the rule ignores inside. */
async function newestOf(unit: SaveUnit, path: string, kind: 'file' | 'dir'): Promise<number> {
  const files = kind === 'dir' ? (await walk(path)).filter((file) => !ignored(unit, file)) : [path]
  let latest = 0
  for (const file of files) {
    latest = Math.max(latest, (await stat(file).catch(() => null))?.mtimeMs ?? 0)
  }
  return latest
}

/** The game's entries in `dir`, and how new the newest of its own is. */
export async function findUnit(dir: string, unit: SaveUnit): Promise<UnitOnDisk> {
  const owned = await ownedIn(unit, dir)
  let newest = 0
  for (const entry of owned) {
    if (isShared(unit, entry.name)) continue
    newest = Math.max(newest, await newestOf(unit, join(dir, entry.name), entry.kind))
  }
  const members = owned.map((entry) => entry.name)
  return { members, shared: members.filter((name) => isShared(unit, name)), newest }
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
  if (owned.length === roots.length) {
    // In code-unit order, so the swap runs the same way on every machine.
    const names = owned.map((root) => root.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return { from: staged, names }
  }

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
 * Is an archive worth unpacking at all, by the names of its roots alone?
 *
 * The first of two looks, taken before a byte is written: a root the rule
 * keeps its hands off refuses the archive outright, and so does any root whose
 * name rules it out (`SaveUnit.mayOwn`) — a PSP folder without the prefix, a
 * GCI whose Dolphin-style name names another game. A name that says nothing
 * either way, a GCI called `zelda.gci`, passes to the header check.
 * One shape is let through to the second look: a single folder that is not
 * the game's by name, which may be a whole card another client zipped. What is
 * inside it, and what every root really holds, is judged once it is unpacked
 * — see `acceptedRoots`.
 */
async function plausibleRoots(unit: SaveUnit, archive: string, nowhere: string): Promise<boolean> {
  const roots = await zipRoots(archive)
  if (roots.length === 0) return false
  if (roots.some((root) => !claimable(unit, root.name))) return false
  const byName = (root: { name: string; kind: 'file' | 'dir' }): boolean =>
    unit.mayOwn ? unit.mayOwn(root.name, root.kind) : unit.owns(root.name, root.kind, nowhere)
  if (roots.every(byName)) return true
  return roots.length === 1 && roots[0].kind === 'dir'
}

/** A rename, replaceable in a test to fail where a disk might. */
type Move = (from: string, to: string) => Promise<void>

/**
 * Replace the game's entries in `dir` with the ones in the archive at
 * `archive`, which the caller has already downloaded and verified.
 *
 * An entry another game owns as well (`SaveUnit.shares`) is written only where
 * nothing is there yet, and one that is there is neither replaced nor removed.
 *
 * Members here that the archive does not carry are removed too — after their
 * copy is taken — because the archive is the unit: a save deleted on another
 * device stays deleted, as it does under Argosy. That is the one thing a pull
 * of a unit removes, and it is logged by name.
 *
 * All or nothing. Should any move fail part-way, every member already swapped
 * is put back the way it was before the error is raised; and should putting
 * one back fail too, the old copies are left where they were moved to, named
 * in the log, rather than cleaned away.
 *
 * Returns the names written. Throws, having changed nothing, when the archive is
 * refused, a member could not be copied aside, or the swap failed.
 */
export async function restoreUnit(options: {
  dir: string
  unit: SaveUnit
  archive: string
  backups: string
  remoteTime: number
  romId: number
  move?: Move
}): Promise<string[]> {
  const { dir, unit, archive, backups, remoteTime, romId } = options
  const move: Move = options.move ?? rename
  await mkdir(dir, { recursive: true })
  const { staging, aside } = await stagingFor(dir, romId)
  await rm(staging, { recursive: true, force: true })
  await rm(aside, { recursive: true, force: true })
  /** Cleared when a failed swap could not be undone, so `aside` is kept. */
  let asideDisposable = true

  const refuse = async (roots: readonly string[]): Promise<never> => {
    log.error(
      'saves',
      'refused an archive holding entries that are not this game\u2019s',
      undefined,
      {
        romId,
        key: unit.key,
        dir,
        roots
      }
    )
    throw new Error(t('error.unitRefused', { name: unit.key }))
  }

  try {
    if (!(await plausibleRoots(unit, archive, staging))) {
      await refuse((await zipRoots(archive)).map((root) => root.name))
    }
    await extractZip(archive, staging, { maxBytes: SAVE_ARCHIVE_MAX_BYTES })
    const accepted = await acceptedRoots(unit, staging)
    if (!accepted) return await refuse((await entriesOf(staging)).map((root) => root.name))

    // An entry another game owns too is the other game's to keep: written only
    // where nothing is there, and otherwise not touched at all — see
    // `SaveUnit.shares`.
    const kept: string[] = []
    const names: string[] = []
    for (const name of accepted.names) {
      if (isShared(unit, name) && (await occupied(join(dir, name)))) kept.push(name)
      else names.push(name)
    }
    const incoming = new Set(accepted.names)
    const local = (await ownedIn(unit, dir)).filter((entry) => !isShared(unit, entry.name))
    const leaving = local.filter((entry) => !incoming.has(entry.name))

    // Every copy first, so a member that cannot be kept stops the pull before
    // anything has changed.
    for (const entry of local) {
      if (!(await backedUp(join(dir, entry.name), backups, entry.kind))) {
        throw new Error(t('error.unitNoBackup', { name: entry.name }))
      }
    }

    await mkdir(aside, { recursive: true })
    /** What has changed so far, in order, for the way back. */
    const done: { name: string; had: boolean; placed: boolean }[] = []
    try {
      for (const name of names) {
        const had = local.some((entry) => entry.name === name)
        if (had) await move(join(dir, name), join(aside, name))
        done.push({ name, had, placed: false })
        await move(join(accepted.from, name), join(dir, name))
        done[done.length - 1].placed = true
      }
      for (const entry of leaving) {
        await move(join(dir, entry.name), join(aside, entry.name))
        done.push({ name: entry.name, had: true, placed: false })
      }
    } catch (cause) {
      log.error(
        'saves',
        'could not swap a pulled entry into place, putting every one back',
        cause,
        {
          romId,
          dir,
          member: done.at(-1)?.name ?? null
        }
      )
      asideDisposable = await rollBack(done, dir, aside, move)
      throw cause
    }

    for (const name of names) {
      const target = join(dir, name)
      const kind = (await stat(target)).isDirectory() ? 'dir' : 'file'
      for (const file of kind === 'dir' ? await walk(target) : [])
        await stampMtime(file, remoteTime)
      await stampMtime(target, remoteTime)
      if (kind === 'dir') await carryOver(unit, join(aside, name), target)
    }
    for (const entry of leaving) {
      log.info('saves', 'removed an entry the pulled copy of this game no longer has', {
        romId,
        member: entry.name,
        dir
      })
    }

    log.info('saves', 'replaced this game\u2019s entries in a shared save folder', {
      romId,
      key: unit.key,
      dir,
      wrote: names,
      keptShared: kept,
      removed: leaving.map((entry) => entry.name)
    })
    return names
  } finally {
    await rm(staging, { recursive: true, force: true }).catch((cause: unknown) =>
      log.warn('saves', 'could not remove a pull\u2019s staging folder', {
        staging,
        reason: (cause as Error).message
      })
    )
    if (asideDisposable) {
      await rm(aside, { recursive: true, force: true }).catch((cause: unknown) =>
        log.warn('saves', 'could not remove the entries a pull replaced', {
          aside,
          reason: (cause as Error).message
        })
      )
    }
  }
}

/**
 * Put the emulator's own files of a replaced member back into the new one —
 * see `SaveUnit.ignoresInside` — each where its folder still exists and the
 * archive brought none: an archive's own describes the files it came with. A
 * copy that fails is logged and left to the emulator, which does without; it
 * never fails the pull.
 */
async function carryOver(unit: SaveUnit, from: string, to: string): Promise<void> {
  for (const file of await walk(from)) {
    if (!ignored(unit, file)) continue
    const target = join(to, relative(from, file))
    try {
      const folder = await stat(dirname(target)).catch(() => null)
      if (!folder?.isDirectory() || (await occupied(target))) continue
      await copyFile(file, target)
    } catch (cause) {
      log.warn('saves', 'could not keep the emulator\u2019s own file in a pulled folder', {
        file: target,
        reason: (cause as Error).message
      })
    }
  }
}

/**
 * Undo a swap that failed part-way, newest step first: a member moved into
 * place is taken out again, and the one it displaced is moved back.
 *
 * True where everything is as it was. False where some step could not be
 * undone — then each failure is logged by name, and the displaced copies stay
 * in `aside` for a person, with the backups beside them.
 */
async function rollBack(
  done: readonly { name: string; had: boolean; placed: boolean }[],
  dir: string,
  aside: string,
  move: Move
): Promise<boolean> {
  let whole = true
  for (const step of done.toReversed()) {
    try {
      if (step.placed) await rm(join(dir, step.name), { recursive: true, force: true })
      if (step.had) await move(join(aside, step.name), join(dir, step.name))
    } catch (cause) {
      whole = false
      log.error('saves', 'could not put a member of a shared save folder back', cause, {
        member: step.name,
        dir,
        kept: join(aside, step.name)
      })
    }
  }
  return whole
}

/**
 * Remove the game's entries from `dir`, each copied aside first — what
 * deleting "this game's save on this device" means for a unit. Nothing else in
 * the folder is touched, and neither is an entry another game owns as well
 * (`SaveUnit.shares`).
 */
export async function removeUnit(dir: string, unit: SaveUnit, backups: string): Promise<string[]> {
  const owned = (await ownedIn(unit, dir)).filter((entry) => !(unit.shares?.(entry.name) ?? false))
  for (const entry of owned) {
    if (!(await backedUp(join(dir, entry.name), backups, entry.kind))) {
      throw new Error(t('error.unitNoBackup', { name: entry.name }))
    }
  }
  for (const entry of owned) await rm(join(dir, entry.name), { recursive: true, force: true })
  return owned.map((entry) => entry.name)
}

/** What `plantSeed` did. */
export type SeedOutcome = 'planted' | 'present' | 'no-source'

/** Is anything at all at `path` — a file, a folder, a link to nowhere? */
async function occupied(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return false
      throw cause
    }
  )
}

/**
 * Copy `seed.from` to `seed.to`, where neither `seed.to` nor anything in
 * `seed.unless` is there yet — see `SaveSeed`.
 *
 * Never over anything. The copy is written beside its target under a name no
 * emulator opens, and then linked into place, which fails rather than replaces
 * where something appeared in between. A filesystem without hard links — the
 * exFAT of an SD card — gets a rename instead, after one more look.
 */
export async function plantSeed(seed: {
  from: string
  to: string
  unless: readonly string[]
}): Promise<SeedOutcome> {
  for (const path of [seed.to, ...seed.unless]) {
    if (await occupied(path)) {
      log.debug('saves', 'no seed needed, the game has its own', { present: path })
      return 'present'
    }
  }
  const source = await stat(seed.from).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null
    throw cause
  })
  if (!source?.isFile()) {
    log.info('saves', 'no seed, there is nothing to copy', { from: seed.from })
    return 'no-source'
  }

  const dir = dirname(seed.to)
  await mkdir(dir, { recursive: true })
  const staged = join(dir, `.${basename(seed.to)}.rommix-seed-${process.pid}`)
  try {
    await copyFile(seed.from, staged)
    try {
      await link(staged, seed.to)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return 'present'
      log.debug('saves', 'no hard link here, renaming the seed into place', { dir, code })
      if (await occupied(seed.to)) return 'present'
      await rename(staged, seed.to)
    }
    log.info('saves', 'seeded a first-launch save from the shared one', {
      from: seed.from,
      to: seed.to
    })
    return 'planted'
  } finally {
    await rm(staged, { force: true }).catch((cause: unknown) =>
      log.warn('saves', 'could not remove a seed’s staging copy', {
        staged,
        reason: (cause as Error).message
      })
    )
  }
}
