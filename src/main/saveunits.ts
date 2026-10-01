import { cp, lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { SaveUnit } from '@config/emulators'
import { t } from './i18n.ts'
import { log } from './log.ts'
import { backupPath, keepBackup, stampMtime, walk } from './savefiles.ts'
import { extractZip, SAVE_ARCHIVE_MAX_BYTES, zipRoots, type ZipRoot } from './zip.ts'

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
 * A pull is verify, back up, stage, swap. Every entry about to change is
 * copied aside first, and the pull stops before touching anything if a copy
 * could not be taken. The archive is unpacked next to the folder rather than
 * into it, so a half-written entry is never where an emulator can see it, and
 * each entry is moved into place by renames on one filesystem: the old one
 * aside, the new one in, every one put back if any rename fails.
 */

/** What of a unit is on this disk. */
export interface UnitOnDisk {
  /** Names of the owned entries directly inside the location's `dir`, sorted. */
  members: string[]
  /** Newest mtime of any file under the members; 0 when there is none. */
  newest: number
}

/** In code-unit order, so a listing reads the same on every machine. */
function byName(a: ZipRoot, b: ZipRoot): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** The entries directly inside `dir` with their kind, links as what they point at. */
async function entriesOf(dir: string): Promise<ZipRoot[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const found: ZipRoot[] = []
  for (const entry of entries) {
    const isDirectory = entry.isSymbolicLink()
      ? await stat(join(dir, entry.name)).then(
          (info) => info.isDirectory(),
          () => false
        )
      : entry.isDirectory()
    found.push({ name: entry.name, kind: isDirectory ? 'dir' : 'file' })
  }
  return found.sort(byName)
}

/** The owned entries of `dir`. */
async function ownedIn(unit: SaveUnit, dir: string): Promise<ZipRoot[]> {
  return (await entriesOf(dir)).filter((entry) => unit.owns(entry.name, entry.kind))
}

/** The game's entries in `dir`, and how new the newest of them is. */
export async function findUnit(dir: string, unit: SaveUnit): Promise<UnitOnDisk> {
  const members = (await ownedIn(unit, dir)).map((entry) => entry.name)
  let newest = 0
  for (const name of members) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    for (const file of info?.isDirectory() ? await walk(path) : [path]) {
      newest = Math.max(newest, (await stat(file).catch(() => null))?.mtimeMs ?? 0)
    }
  }
  return { members, newest }
}

/**
 * Which roots of an archive are the game's — the whole of it, or nothing —
 * judged by its directory before a byte of it is written.
 *
 * Both shapes Argosy has put on servers are taken (`matchArchive` and
 * `unpackArchive` in its `PlatformSaveHandlerRegistry.kt`, commit 60dc343,
 * :791-821): every root a folder of the game's, or a single folder — the card,
 * named whatever it was called there — holding the game's folders among other
 * games'. The second is read one level down and only the game's folders in it
 * are taken; what is beside them is another game's and is left out, since the
 * card it came from was never going to be written anywhere.
 *
 * Null means refused.
 */
async function acceptedRoots(
  unit: SaveUnit,
  archive: string
): Promise<{ under: string | null; names: string[] } | null> {
  const roots = await zipRoots(archive)
  if (roots.length > 0 && roots.every((root) => unit.owns(root.name, root.kind))) {
    return { under: null, names: roots.sort(byName).map((root) => root.name) }
  }
  if (roots.length !== 1 || roots[0].kind !== 'dir') return null
  const names = (await zipRoots(archive, roots[0].name))
    .filter((entry) => unit.owns(entry.name, entry.kind))
    .sort(byName)
    .map((entry) => entry.name)
  return names.length > 0 ? { under: roots[0].name, names } : null
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

/** Copy one entry aside, and say whether the copy is really there. */
async function backedUp(path: string, backups: string, kind: 'file' | 'dir'): Promise<boolean> {
  try {
    await keepBackup(path, backups, kind === 'dir')
  } catch (cause) {
    log.warn('saves', 'could not copy an entry of a shared save folder aside', {
      path,
      backups,
      reason: (cause as Error).message
    })
    return false
  }
  // As sure as `keepBackup` is: its copy is there, under the newest slot.
  return (await stat(backupPath(backups, path, 1)).catch(() => null)) !== null
}

/**
 * Move the entries an earlier pull could not put back — see `rollBack` — out
 * of the way under a name of their own, rather than letting this pull's
 * `aside` replace them: they are kept for a person, and may be the only copy.
 */
async function keepLeftAside(aside: string): Promise<void> {
  if (!(await occupied(aside))) return
  const kept = `${aside}-${Date.now()}`
  await rename(aside, kept)
  log.warn('saves', 'kept the entries an earlier pull could not put back', { kept })
}

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

/** A rename, replaceable in a test to fail where a disk might. */
type Move = (from: string, to: string) => Promise<void>

/**
 * Replace the game's entries in `dir` with the ones in the archive at
 * `archive`, which the caller has already downloaded and verified.
 *
 * Placed as Argosy places it (`unzipToFolder` and `unzipSelectedRootChildren`
 * in its `data/sync/SaveArchiver.kt`, commit 60dc343, :260-299 and :380-435):
 * every file the archive carries replaces the one at that path, and a file
 * only this device has — PCSX2's `_pcsx2_index` beside a save another client
 * zipped without it — stays. An entry of the game's that the archive does not
 * carry is left where it is. The merge is made in the staging folder, so what
 * moves into the card is whole.
 *
 * All or nothing. Should any move fail part-way, every entry already swapped
 * is put back the way it was before the error is raised; and should putting
 * one back fail too, the old copies are left where they were moved to, named
 * in the log, rather than cleaned away.
 *
 * Returns the names written. Throws, having changed nothing, when the archive is
 * refused, an entry could not be copied aside, or the swap failed.
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
  const accepted = await acceptedRoots(unit, archive)
  if (!accepted) {
    log.error('saves', 'refused an archive holding entries that are not this game’s', undefined, {
      romId,
      key: unit.key,
      dir,
      roots: (await zipRoots(archive)).map((root) => root.name)
    })
    throw new Error(t('error.unitRefused', { name: unit.key }))
  }

  await mkdir(dir, { recursive: true })
  const { staging, aside } = await stagingFor(dir, romId)
  await rm(staging, { recursive: true, force: true })
  await keepLeftAside(aside)
  /** Cleared when a failed swap could not be undone, so `aside` is kept. */
  let asideDisposable = true

  try {
    await extractZip(archive, staging, { maxBytes: SAVE_ARCHIVE_MAX_BYTES })
    const from = accepted.under ? join(staging, accepted.under) : staging
    const names = accepted.names
    for (const name of names) {
      const incoming = join(from, name)
      const files = (await stat(incoming)).isDirectory() ? await walk(incoming) : []
      for (const file of [...files, incoming]) await stampMtime(file, remoteTime)
      await keepLocalOnly(join(dir, name), incoming)
    }

    // Every copy first, so an entry that cannot be kept stops the pull before
    // anything has changed.
    for (const name of names) {
      const info = await stat(join(dir, name)).catch(() => null)
      if (
        info &&
        !(await backedUp(join(dir, name), backups, info.isDirectory() ? 'dir' : 'file'))
      ) {
        throw new Error(t('error.unitNoBackup', { name }))
      }
    }

    await mkdir(aside, { recursive: true })
    /** What has changed so far, in order, for the way back. */
    const done: { name: string; had: boolean; placed: boolean }[] = []
    try {
      for (const name of names) {
        const had = await occupied(join(dir, name))
        if (had) await move(join(dir, name), join(aside, name))
        done.push({ name, had, placed: false })
        await move(join(from, name), join(dir, name))
        done[done.length - 1].placed = true
      }
    } catch (cause) {
      log.error(
        'saves',
        'could not swap a pulled entry into place, putting every one back',
        cause,
        {
          romId,
          dir,
          entry: done.at(-1)?.name ?? null
        }
      )
      asideDisposable = await rollBack(done, dir, aside, move)
      throw cause
    }

    log.info('saves', 'replaced this game’s entries in a shared save folder', {
      romId,
      key: unit.key,
      dir,
      wrote: names
    })
    return names
  } finally {
    await rm(staging, { recursive: true, force: true }).catch((cause: unknown) =>
      log.warn('saves', 'could not remove a pull’s staging folder', {
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
 * Copy into the staged `incoming` folder every file of the local `folder` the
 * archive did not carry, dates and all, so the folder that moves into the card
 * is the archive's files over this device's. Nothing where either is not a
 * folder: a file the archive carries replaces whatever was there.
 */
async function keepLocalOnly(folder: string, incoming: string): Promise<void> {
  const [here, there] = await Promise.all(
    [stat(folder), stat(incoming)].map((s) => s.catch(() => null))
  )
  if (!here?.isDirectory() || !there?.isDirectory()) return
  for (const file of await walk(folder)) {
    const target = join(incoming, relative(folder, file))
    if (await occupied(target)) continue
    await mkdir(dirname(target), { recursive: true })
    await cp(file, target, { preserveTimestamps: true })
  }
}

/**
 * Undo a swap that failed part-way, newest step first: an entry moved into
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
      log.error('saves', 'could not put an entry of a shared save folder back', cause, {
        entry: step.name,
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
