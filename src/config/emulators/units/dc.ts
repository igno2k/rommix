import type { SaveUnit } from '../savepaths.ts'
import { dreamcastVmuName } from './keys.ts'

/**
 * One Dreamcast game's own VMU, as Flycast keeps it with per-game VMUs on.
 *
 * One file, `<product>.A1.bin`, in the directory the rest of the core's saves
 * are in, and carried as that file: it is a whole VMU image, which every
 * Dreamcast emulator reads as it is. Only port A1 is the game's own — with
 * "VMU A1" the other ports stay the shared cards they always were.
 *
 * A file named after the ROM instead is what an older Flycast wrote; the
 * current one reads it only where the product-named file is missing, and a
 * pull writes that one, so it is left alone.
 */
export function dreamcastUnit(key: string): SaveUnit | null {
  const fileName = dreamcastVmuName(key)
  if (!fileName) return null
  return {
    key: key.trim(),
    carriedAs: 'file',
    owns: (name, kind) => kind === 'file' && name === fileName,
    fileName
  }
}
