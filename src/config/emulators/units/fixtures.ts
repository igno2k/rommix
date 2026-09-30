import type { SaveEnvironment } from '../savepaths.ts'

/**
 * Small synthetic copies of the shared save folders the unit rules read, for
 * the tests on both sides of them: `units.test.ts` reads them through a fake
 * environment, and the main process's tests write them to a real disk and pull
 * over them.
 *
 * Each holds two games, so every test can ask the question that matters — what
 * happened to the game that was not being synced — plus the entries a rule has
 * to leave alone for a reason of its own. Contents are latin1 strings, one
 * character per byte, which is what `SaveEnvironment.head` answers with.
 */

/** Relative path inside the folder -> contents. Directories are implied. */
export type FixtureTree = Readonly<Record<string, string>>

/** `value` as `size` little-endian bytes. */
function le(value: number, size: number): string {
  let out = ''
  for (let index = 0; index < size; index += 1) {
    out += String.fromCharCode(Math.floor(value / 256 ** index) % 256)
  }
  return out
}

/** A GameCube disc image's first bytes: the id, and the magic at 0x1C. */
export function gameCubeIso(gameId: string): string {
  return `${gameId}${'\x00'.repeat(0x1c - gameId.length)}\xC2\x33\x9F\x3D${'\x00'.repeat(0x20)}`
}

/** The same disc as an RVZ, whose copy of the disc header sits at 0x58. */
export function gameCubeRvz(gameId: string): string {
  return `RVZ\x01${'\x00'.repeat(0x58 - 4)}${gameCubeIso(gameId)}`
}

/**
 * A `.gci`: the 0x40-byte directory entry — game code, maker code, then the
 * file name the game gave the save — followed by the save's bytes.
 */
export function gci(gameId: string, internalName: string, body: string): string {
  const name = internalName.padEnd(32, '\x00').slice(0, 32)
  const entry = `${gameId.slice(0, 4)}${gameId.slice(4, 6)}\xFF\x00${name}`
  return `${entry.padEnd(0x40, '\x00')}${body}`
}

/**
 * A PARAM.SFO declaring `keys`, each with an empty string value — enough for
 * a reader that looks at which keys there are.
 */
export function paramSfo(keys: readonly string[]): string {
  const indexSize = keys.length * 16
  const keyTable = keys.map((key) => `${key}\x00`).join('')
  const keyTableStart = 20 + indexSize
  const dataTableStart = keyTableStart + keyTable.length
  let index = ''
  let keyOffset = 0
  keys.forEach((key, at) => {
    // utf8 string, one byte long, four bytes reserved.
    index += le(keyOffset, 2) + le(0x0204, 2) + le(1, 4) + le(4, 4) + le(at * 4, 4)
    keyOffset += key.length + 1
  })
  const header = `\x00PSF${le(0x0101, 4)}${le(keyTableStart, 4)}${le(dataTableStart, 4)}${le(keys.length, 4)}`
  return `${header}${index}${keyTable}${'\x00'.repeat(keys.length * 4)}`
}

// ---------------------------------------------------------------------------
// PCSX2 folder card
// ---------------------------------------------------------------------------

/** The game being synced: `BASLUS-20152`, which writes two folders. */
export const PS2_KEY = 'SLUS-20152'
export const PS2_OWNED: readonly string[] = ['BASLUS-20152AC04', 'BASLUS-20152SYS']

/** `Mcd001.ps2/` with the game, another game, the system folder and PCSX2's files. */
export const PS2_CARD: FixtureTree = {
  _pcsx2_superblock: 'PCSX2 folder card superblock',
  _pcsx2_index: 'root index',
  'BASLUS-20152AC04/icon.sys': 'icon of the first game',
  'BASLUS-20152AC04/BASLUS-20152AC04': 'progress of the first game',
  'BASLUS-20152SYS/icon.sys': 'system icon of the first game',
  'BASLUS-20152SYS/settings': 'settings of the first game',
  'BASLUS-21693XX/icon.sys': 'icon of the second game',
  'BASLUS-21693XX/BASLUS-21693XX': 'progress of the second game',
  'BADATA-SYSTEM/history': 'the console history every game appends to'
}

// ---------------------------------------------------------------------------
// Dolphin GCI folder
// ---------------------------------------------------------------------------

export const GC_KEY = 'GZLE01'
export const GC_OWNED: readonly string[] = ['01-GZLE-gczelda2.gci', '01-GZLE-gczelda2b.gci']

/** One region's `Card A/`: the game's two saves, another game's, one deleted. */
export const GCI_FOLDER: FixtureTree = {
  '01-GZLE-gczelda2.gci': gci('GZLE01', 'gczelda2', 'first quest'),
  '01-GZLE-gczelda2b.gci': gci('GZLE01', 'gczelda2b', 'second quest'),
  '8P-GM4E-MarioKart Double Dash!!.gci': gci('GM4E8P', 'MarioKart Double Dash!!', 'lap times'),
  '01-GZLE-gczelda2.deleted.gci': gci('GZLE01', 'gczelda2', 'a save deleted in Dolphin')
}

// ---------------------------------------------------------------------------
// PPSSPP SAVEDATA
// ---------------------------------------------------------------------------

export const PSP_KEY = 'ULUS10064'
export const PSP_OWNED: readonly string[] = [
  'ULUS10064DATA00',
  'ULUS10064DATA01',
  'ULUS10064SETTINGS'
]

/** `SAVEDATA/` with the game's three saves, its installed data, and another game. */
export const SAVEDATA: FixtureTree = {
  'ULUS10064DATA00/PARAM.SFO': paramSfo(['CATEGORY', 'SAVEDATA_PARAMS', 'TITLE']),
  'ULUS10064DATA00/DATA.BIN': 'first slot',
  'ULUS10064DATA01/PARAM.SFO': paramSfo(['CATEGORY', 'SAVEDATA_FILE_LIST', 'TITLE']),
  'ULUS10064DATA01/DATA.BIN': 'second slot',
  'ULUS10064SETTINGS/PARAM.SFO': paramSfo(['SAVEDATA_PARAMS']),
  'ULUS10064SETTINGS/SETTINGS.BIN': 'options',
  'ULUS10064INSTALL/PARAM.SFO': paramSfo(['CATEGORY', 'TITLE']),
  'ULUS10064INSTALL/DATA.PAK': 'game data copied off the disc',
  'ULES00151DATA/PARAM.SFO': paramSfo(['SAVEDATA_PARAMS']),
  'ULES00151DATA/DATA.BIN': 'the other game'
}

// ---------------------------------------------------------------------------
// Flycast per-game VMU
// ---------------------------------------------------------------------------

export const DC_KEY = 'MK-51035'
export const DC_OWNED: readonly string[] = ['MK-51035.A1.bin']

/** The core's save folder: the game's VMU, its other ports, an old name, another game. */
export const VMU_DIR: FixtureTree = {
  'MK-51035.A1.bin': 'the game own VMU',
  'MK-51035.A2.bin': 'port A2, still a shared card',
  'Crazy Taxi (USA).A1.bin': 'what an older Flycast named it',
  'T-8101N.A1.bin': 'the other game VMU'
}

// ---------------------------------------------------------------------------
// Reading one without a disk
// ---------------------------------------------------------------------------

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
