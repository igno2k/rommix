/**
 * Reading the key that names one game's entries in a shared save folder.
 *
 * Pure string work on latin1 — what `SaveEnvironment.head` hands back, one
 * character per byte — because this module is loaded by the renderer as well
 * and has no `Buffer` to reach for. Every reader answers null for bytes it does
 * not recognise rather than guessing: a key read wrongly is a pull that claims
 * another game's save.
 *
 * The formats are the ones Argosy, RomM's reference client, reads for the same
 * purpose — `GameCubeHeaderParser.kt`, `PlatformSaveHandlerRegistry.kt`,
 * `PrefixBundleFolderHandler.kt` and `DreamcastSaveHandler.kt` in its sources —
 * so the two clients name a save by the same key.
 */

/** Unsigned little-endian integer of `size` bytes at `offset`, or null past the end. */
function uint(bytes: string, offset: number, size: 2 | 4): number | null {
  if (offset + size > bytes.length) return null
  let value = 0
  for (let index = size - 1; index >= 0; index -= 1) {
    value = value * 256 + bytes.charCodeAt(offset + index)
  }
  return value
}

// ---------------------------------------------------------------------------
// GameCube
// ---------------------------------------------------------------------------

/** A disc id: four characters of game code and two of maker. */
const GAME_ID = /^[A-Z0-9]{6}$/

/** The GameCube disc magic, `0xC2339F3D`, at 0x1C of the disc header. */
const GAMECUBE_MAGIC = '\xC2\x33\x9F\x3D'

/**
 * Where the disc header starts in each container Dolphin opens.
 *
 * A plain image starts with it. RVZ and WIA keep a copy of it at 0x58, inside
 * their second header; CISO puts a 0x8000-byte block map in front of the image.
 * GCZ compresses the header with everything else and is not read — that game
 * has no key unless RomM supplies one.
 */
const HEADER_AT: readonly { magic: string; offset: number }[] = [
  { magic: 'RVZ\x01', offset: 0x58 },
  { magic: 'WIA\x01', offset: 0x58 },
  { magic: 'CISO', offset: 0x8000 }
]

/** How much of a disc image `gameCubeId` needs to see. */
export const GAMECUBE_HEAD_BYTES = 0x8000 + 0x20

/**
 * The six-character id of a GameCube disc, read from the start of its image.
 *
 * Checked against the disc magic as well as the shape of the id, so an image
 * of something else that happens to start with six capitals is not taken for
 * a game.
 */
export function gameCubeId(head: string | null): string | null {
  if (!head) return null
  const at = HEADER_AT.find((container) => head.startsWith(container.magic))?.offset ?? 0
  const id = head.slice(at, at + 6)
  if (!GAME_ID.test(id)) return null
  if (head.slice(at + 0x1c, at + 0x20) !== GAMECUBE_MAGIC) return null
  return id
}

/**
 * The game a `.gci` file belongs to, from its own header.
 *
 * A GCI is a memory-card directory entry followed by the save's blocks, and the
 * entry opens with the game code and the maker code — the disc id, in the same
 * order. The file name says the same thing in Dolphin's `<maker>-<code>-<name>`
 * order, but a name is whatever whoever copied the file typed; the header is
 * what Dolphin itself loads the save by.
 */
export function gciGameId(head: string | null): string | null {
  if (!head || head.length < 6) return null
  const id = head.slice(0, 6)
  return GAME_ID.test(id) ? id : null
}

/**
 * The game a `.gci` name claims, for a file whose header could not be read.
 *
 * `01-GZLE-gczelda2.gci` is maker `01`, code `GZLE`: the disc id `GZLE01`.
 */
export function gciNameGameId(name: string): string | null {
  const match = /^([A-Z0-9]{2})-([A-Z0-9]{4})-/i.exec(name)
  return match ? `${match[2]}${match[1]}`.toUpperCase() : null
}

// ---------------------------------------------------------------------------
// PlayStation 2
// ---------------------------------------------------------------------------

/**
 * A name reduced to what PCSX2 and the serial databases agree on: letters and
 * digits, upper case. `BASLUS-20152AC04` and `BASLUS_20152AC04` are one save.
 */
export function normalizeForMatch(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * The folder-name prefixes a PS2 game's saves start with, most specific first.
 *
 * A save folder on a PS2 card is the region prefix — `BA` America, `BE` Europe,
 * `BI` Japan and Asia — then the serial, then whatever the game adds. RomM's
 * key may carry the prefix already (`BASLUS-20152`) or be the bare serial
 * (`SLUS-20152`), whose third letter says the region. The bare serial is kept
 * as a second prefix for the folders a homebrew tool wrote without one, which
 * is Argosy's fallback too.
 *
 * Empty for a key that is not a serial at all, which leaves the game with no
 * unit rather than one matching every folder on the card.
 */
export function ps2Stems(key: string): string[] {
  const serial = normalizeForMatch(key)
  if (/^B[AEI][A-Z]{4}\d{3,}$/.test(serial)) return [serial, serial.slice(2)]
  if (!/^[A-Z]{4}\d{3,}$/.test(serial)) return []
  const region = serial[2]
  const prefix =
    region === 'E' ? 'BE' : region === 'P' || region === 'J' || region === 'K' ? 'BI' : 'BA'
  return [`${prefix}${serial}`, serial]
}

// ---------------------------------------------------------------------------
// PSP
// ---------------------------------------------------------------------------

/** A PSP disc id: four letters and five digits, `ULUS10041`. */
export function pspDiscId(key: string): string | null {
  const id = normalizeForMatch(key)
  return /^[A-Z]{4}\d{5}$/.test(id) ? id : null
}

/** How much of a PARAM.SFO `paramSfoKeys` reads; the key table sits near the front. */
export const PARAM_SFO_HEAD_BYTES = 0x2000

/**
 * The keys a PARAM.SFO declares, or null for bytes that are not one.
 *
 * Parsed rather than searched: the header says where the key table is and how
 * many entries point into it, so a value that happens to spell a key name is
 * not read as one.
 */
export function paramSfoKeys(head: string | null): string[] | null {
  if (!head || !head.startsWith('\x00PSF')) return null
  const keyTable = uint(head, 8, 4)
  const count = uint(head, 16, 4)
  if (keyTable === null || count === null || count > 1024) return null

  const keys: string[] = []
  for (let entry = 0; entry < count; entry += 1) {
    const keyOffset = uint(head, 20 + entry * 16, 2)
    if (keyOffset === null) return null
    const start = keyTable + keyOffset
    const end = head.indexOf('\x00', start)
    if (start >= head.length || end === -1) return null
    keys.push(head.slice(start, end))
  }
  return keys
}

// ---------------------------------------------------------------------------
// Dreamcast
// ---------------------------------------------------------------------------

/**
 * The file Flycast keeps a game's own VMU in, when it keeps one per game.
 *
 * Its own rule, in `getVmuPath` in both the standalone and the libretro build:
 * the product number with each of ` /\:*?|<>` turned into `_`, then the port.
 * Trailing blanks are trimmed first because the IP.BIN field is padded with
 * them and Flycast reads it trimmed.
 */
export function dreamcastVmuName(product: string, port = 'A1'): string | null {
  const trimmed = product.trim()
  if (!trimmed) return null
  return `${trimmed.replace(/[ /\\:*?|<>]/g, '_')}.${port}.bin`
}
