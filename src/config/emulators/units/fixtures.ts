import type { SaveEnvironment } from '../savepaths.ts'

/**
 * A small synthetic PCSX2 folder card, for the tests on both sides of the PS2
 * rule: `ps2.test.ts` reads it, and the main process's tests write it to a
 * real disk and pull over it.
 *
 * It holds more than one game, so every test can ask the question that
 * matters — what happened to the game that was not being synced — plus the
 * entries no game owns.
 */

/** Relative path inside the card -> contents. Directories are implied. */
export type FixtureTree = Readonly<Record<string, string>>

/** The game being synced: `BASLUS-20152`, which writes two folders. */
export const PS2_KEY = 'SLUS-20152'
export const PS2_OWNED: readonly string[] = ['BASLUS-20152AC04', 'BASLUS-20152SYS']

/** `Mcd001.ps2/` with the game, another game, the system folder and PCSX2's files. */
export const PS2_CARD: FixtureTree = {
  _pcsx2_superblock: 'PCSX2 folder card superblock',
  _pcsx2_index: 'root index',
  'BASLUS-20152AC04/_pcsx2_index': 'order and dates of the first folder',
  'BASLUS-20152AC04/icon.sys': 'icon of the first game',
  'BASLUS-20152AC04/BASLUS-20152AC04': 'progress of the first game',
  'BASLUS-20152SYS/icon.sys': 'system icon of the first game',
  'BASLUS-20152SYS/settings': 'settings of the first game',
  'BASLUS-21693XX/icon.sys': 'icon of the second game',
  'BASLUS-21693XX/BASLUS-21693XX': 'progress of the second game',
  'BADATA-SYSTEM/history': 'the console history every game appends to'
}

/**
 * A `SaveEnvironment` over a set of trees, each mounted at an absolute path —
 * the pure tests' stand-in for the disk.
 */
export function treeEnvironment(mounts: Readonly<Record<string, FixtureTree>>): SaveEnvironment {
  const files = new Map<string, string>()
  for (const [root, tree] of Object.entries(mounts)) {
    for (const [relative, contents] of Object.entries(tree))
      files.set(`${root}/${relative}`, contents)
  }
  const children = (path: string, wantDirs: boolean): string[] => {
    const found = new Set<string>()
    for (const file of files.keys()) {
      if (!file.startsWith(`${path}/`)) continue
      const rest = file.slice(path.length + 1).split('/')
      if (wantDirs ? rest.length > 1 : rest.length === 1) found.add(rest[0])
    }
    return [...found].sort()
  }
  return {
    exists: (path) =>
      files.has(path) || children(path, true).length + children(path, false).length > 0,
    dirs: (path) => children(path, true),
    files: (path) => children(path, false),
    text: (path) => files.get(path) ?? null,
    head: (path, bytes) => files.get(path)?.slice(0, bytes) ?? null,
    newest: () => 0
  }
}
