import type { SaveUnit } from '../savepaths.ts'
import { normalizeForMatch, ps2Stems } from './keys.ts'

/**
 * One PS2 game's saves on a PCSX2 folder memory card.
 *
 * A folder card is a directory ending `.ps2` holding one folder per save, the
 * way a real card's file system holds them, plus PCSX2's own bookkeeping. A
 * game owns every folder whose name starts with its serial stem — a game
 * commonly writes two, `BASLUS-20152AC04` beside `BASLUS-20152SYS` — and
 * nothing else; the card's `_pcsx2_superblock` and `_pcsx2_index` are
 * PCSX2's, and a pull that replaced them would describe a different card.
 */

/** PCSX2's own files at the root of a folder card, never a game's. */
export const PS2_CARD_FILES: readonly string[] = ['_pcsx2_superblock', '_pcsx2_index']

/** The file that marks a directory as a PCSX2 folder card. */
export const PS2_SUPERBLOCK = '_pcsx2_superblock'

/**
 * The tags Argosy uploads a PS2 save under from Android's PCSX2 forks. Their
 * folder cards are PCSX2's format, so a save one of them wrote is this one.
 */
export const PS2_FORK_TAGS: readonly string[] = ['armsx2', 'nethersx2', 'aethersx2']

export function ps2Unit(key: string): SaveUnit | null {
  const stems = ps2Stems(key)
  if (stems.length === 0) return null
  return {
    key,
    carriedAs: 'archive',
    owns: (name) => {
      if (PS2_CARD_FILES.includes(name)) return false
      const normalized = normalizeForMatch(name)
      return stems.some((stem) => normalized.startsWith(stem))
    },
    keepsHandsOff: PS2_CARD_FILES,
    alsoAccepts: PS2_FORK_TAGS
  }
}
