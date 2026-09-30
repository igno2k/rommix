import type { SaveUnit } from '../savepaths.ts'
import { normalizeForMatch, ps2Stems } from './keys.ts'

/**
 * One PS2 game's saves on a PCSX2 folder memory card.
 *
 * A folder card is a directory ending `.ps2` holding one folder per save, the
 * way a real card's file system holds them, plus PCSX2's own bookkeeping. A
 * game owns every folder whose name starts with its serial stem — a game
 * commonly writes two, `BASLUS-20152AC04` beside `BASLUS-20152SYS` — and every
 * folder PCSX2's game database lets it see besides (see `gamedb.ts`): a
 * sequel's bonus read of the first game's save, the other discs of the same
 * game. Nothing else: the card's `_pcsx2_superblock` and `_pcsx2_index` are
 * PCSX2's, and a pull that replaced them would describe a different card.
 *
 * Nor the console's own folders. PCSX2 shows the system configuration and the
 * network settings to every game (`AddFolder` in
 * `SIO/Memcard/MemoryCardFolder.cpp` puts `DATA-SYSTEM` and `BWNETCNF` in front
 * of every filter), which is exactly why they are no one game's to carry: a
 * pull of one game would put back whatever the console held when that game
 * last went up.
 */

/** PCSX2's own files at the root of a folder card, never a game's. */
export const PS2_CARD_FILES: readonly string[] = ['_pcsx2_superblock', '_pcsx2_index']

/**
 * What names the console's shared folders, matched anywhere in a name as PCSX2
 * matches it — `BADATA-SYSTEM`, `BEDATA-SYSTEM`, `BIDATA-SYSTEM`, `BWNETCNF` —
 * plus the region-prefixed spelling of the network settings.
 */
const SYSTEM_MARKS: readonly string[] = ['DATA-SYSTEM', 'WNETCNF']

/**
 * The console's shared folders by the names they are written under, for the
 * hands-off list: an archive carrying one of them is refused before it is
 * unpacked. `ps2Unit`'s `owns` rules out every other spelling of them too.
 */
export const PS2_SYSTEM_FOLDERS: readonly string[] = [
  'BADATA-SYSTEM',
  'BEDATA-SYSTEM',
  'BIDATA-SYSTEM',
  'BWNETCNF',
  'BAWNETCNF',
  'BEWNETCNF',
  'BIWNETCNF'
]

/**
 * PCSX2's index inside every save folder of a folder card: the order and dates
 * of the folder's files. Not the save — a raw card has no such file, and PCSX2
 * orders a folder without one by itself (`GetOrderedFiles` in
 * `MemoryCardFolder.cpp`) — so a push neither carries nor hashes it. See
 * `SaveUnit.ignoresInside`.
 *
 * `_pcsx2_meta_directory` and the `_pcsx2_meta` folder are not in this list:
 * they hold the raw directory entry of a folder or file whose PS2 name, mode
 * or attributes the host file system cannot express (`WriteMetadata`), and a
 * card loaded without them has cleaned names and default modes. They are part
 * of the save.
 */
export const PS2_FOLDER_FILES: readonly string[] = ['_pcsx2_index']

/** The file that marks a directory as a PCSX2 folder card. */
export const PS2_SUPERBLOCK = '_pcsx2_superblock'

/**
 * The tags Argosy uploads a PS2 save under from Android's PCSX2 forks. Their
 * folder cards are PCSX2's format, so a save one of them wrote is this one.
 */
export const PS2_FORK_TAGS: readonly string[] = ['armsx2', 'nethersx2', 'aethersx2']

/** Is this one of the console's folders, which no game's unit carries? */
export function isPs2SystemFolder(name: string): boolean {
  return SYSTEM_MARKS.some((mark) => name.includes(mark))
}

/** What else decides a PS2 unit besides its key. */
export interface Ps2UnitOptions {
  /**
   * The game's `memcardFilters` from PCSX2's database, matched the way PCSX2
   * matches them — anywhere in a folder's name, as written, and only against
   * folders (`FilterMatches`; files at the card's root are never a game's).
   */
  filters?: readonly string[]
  /**
   * The serial's own folders are another game's: RomM files a second ROM under
   * the same serial, and this ROM is not the game PCSX2's database names for
   * it. Every owned folder is then `shares`.
   */
  serialShared?: boolean
  /** Why the rule is narrower than PCSX2's, for the log — see `SaveUnit.note`. */
  note?: string
  /** See `SaveUnit.sharingKey`. */
  sharingKey?: (saveTarget: string) => string | null
}

/**
 * The unit of the game RomM keyed as `key`.
 *
 * Filters add to the serial rather than replace it as they do in PCSX2, where
 * an entry that lists filters without its own serial hides the game's own
 * folders from it: for a sync the game's own folders are the one part that is
 * certainly its. A folder owned only through a filter is another game's too,
 * and is `shares`.
 */
export function ps2Unit(key: string, options: Ps2UnitOptions = {}): SaveUnit | null {
  const stems = ps2Stems(key)
  if (stems.length === 0) return null
  const extra = (options.filters ?? []).filter((filter) => filter !== '')
  const bySerial = (name: string): boolean => {
    const normalized = normalizeForMatch(name)
    return stems.some((stem) => normalized.startsWith(stem))
  }
  const byFilter = (name: string, kind: 'file' | 'dir'): boolean =>
    kind === 'dir' && extra.some((filter) => name.includes(filter))
  const serialShared = options.serialShared === true

  return {
    key,
    carriedAs: 'archive',
    owns: (name, kind) => {
      if (PS2_CARD_FILES.includes(name) || isPs2SystemFolder(name)) return false
      return bySerial(name) || byFilter(name, kind)
    },
    shares: (name) => serialShared || !bySerial(name),
    keepsHandsOff: [...PS2_CARD_FILES, ...PS2_SYSTEM_FOLDERS],
    ignoresInside: PS2_FOLDER_FILES,
    alsoAccepts: PS2_FORK_TAGS,
    ...(options.note ? { note: options.note } : {}),
    ...(options.sharingKey ? { sharingKey: options.sharingKey } : {})
  }
}
