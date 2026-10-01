import type { SaveUnit } from '../savepaths.ts'

/**
 * One PS2 game's saves on a PCSX2 folder memory card.
 *
 * A folder card is a directory holding one folder per save, the way a real
 * card's file system holds them, beside PCSX2's `_pcsx2_superblock` and
 * `_pcsx2_index`. A game owns the folders whose names start with its serial —
 * a game commonly writes two, `BASLUS-20152AC04` beside `BASLUS-20152SYS` —
 * matched exactly as Argosy matches them, so that both clients claim the same
 * folders (`Ps2FolderHandler.folderMatches` and `findInCard` in Argosy's
 * `data/sync/platform/PlatformSaveHandlerRegistry.kt`, commit 60dc343,
 * :1042-1094). Folders only: a file at the card's root is never a game's.
 */

/**
 * The tags Argosy uploads a PS2 save under from Android's PCSX2 forks: the
 * emulator's own id, sent as it is for an emulator that is not a libretro core
 * (`SaveUploader.kt` :110 -> `EmulatorRegistry.toServerEmulator`; the PS2 ids
 * in `EmulatorRegistry.kt` :746-802 and :1096, Argosy 60dc343). Their folder
 * cards are PCSX2's format, so a save one of them wrote is this one.
 */
const PS2_FORK_TAGS: readonly string[] = [
  'nethersx2',
  'aethersx2',
  'armsx2',
  'armsx2_refresh',
  'psx2'
]

/** The file that marks a directory as a PCSX2 folder card. */
export const PS2_SUPERBLOCK = '_pcsx2_superblock'

/** A serial with the card's region prefix, `BASLUS…`. */
const REGION_PREFIXED = /^B[AEI][A-Z]{4}/

/** A name as Argosy compares it: no `-` or `_`, upper case. */
function normalize(name: string): string {
  return name.replace(/[-_]/g, '').toUpperCase()
}

/**
 * The folder-name stem of a serial: the serial with the region prefix the
 * folders are written under — `BA` America, `BE` Europe, `BI` Japan and Asia,
 * read off the serial's third letter. A key that already carries it is taken
 * as it is. Null for a key that is not a serial, which would otherwise be a
 * stem matching folders that are no game's.
 */
export function ps2Stem(key: string): string | null {
  const cleaned = normalize(key)
  if (REGION_PREFIXED.test(cleaned)) return /^B[AEI][A-Z]{4}\d/.test(cleaned) ? cleaned : null
  const bare = /^([A-Z]{4})\d/.exec(cleaned)
  if (!bare) return null
  const region = bare[1][2]
  const prefix =
    region === 'E' ? 'BE' : region === 'P' || region === 'J' || region === 'K' ? 'BI' : 'BA'
  return `${prefix}${cleaned}`
}

/** The stem without its region prefix: Argosy's fallback for a key read with the wrong one. */
function withoutRegion(stem: string): string {
  return REGION_PREFIXED.test(stem) ? stem.slice(2) : stem
}

/** The unit of the game RomM keyed as `key`, or null where the key is no serial. */
export function ps2Unit(key: string): SaveUnit | null {
  const stem = ps2Stem(key)
  if (!stem) return null
  return {
    key,
    owns: (name, kind) => {
      if (kind !== 'dir') return false
      const folder = normalize(name)
      return folder.startsWith(stem) || withoutRegion(folder).startsWith(withoutRegion(stem))
    },
    alsoAccepts: PS2_FORK_TAGS
  }
}
