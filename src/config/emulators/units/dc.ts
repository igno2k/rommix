import { joinPath } from '../savepaths.ts'
import type { SaveSeed, SaveUnit } from '../savepaths.ts'
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

/**
 * The `reicast_per_content_vmus` values that give port A1 a VMU of each game's
 * own. Flycast compares them exactly (`update_variables` in `libretro.cpp`).
 */
const PER_CONTENT_A1: ReadonlySet<string> = new Set(['VMU A1', 'All VMUs'])

/**
 * The size of Flycast's buffer for the ROM's file name, the terminating NUL
 * included (`g_base_name` in `libretro.cpp`). A longer name is cut to fit.
 */
const FLYCAST_BASE_NAME_BYTES = 128

/**
 * The extensions Flycast takes for a NAOMI or Atomiswave board rather than a
 * Dreamcast disc (`retro_load_game` in `libretro.cpp`). A board has no VMU,
 * and an archive's content name is not the file RomMix sees either. Flycast
 * compares two spellings of each; any case is refused here, which errs on the
 * side of no copy.
 */
const ARCADE = /\.(lst|bin|dat|zip|7z)$/i

/**
 * The name Flycast gives the content, and with it the VMU it writes when the
 * game has no product number: the file name, cut to Flycast's buffer, minus
 * everything from its last dot (`extract_basename` and `remove_extension` in
 * `libretro.cpp`), and `vmu_save` where nothing is left.
 *
 * The cut is in bytes. Null where it falls inside a character, a name that
 * cannot be written back as text.
 */
export function flycastContentName(romPath: string): string | null {
  // libretro-common's `find_last_slash` takes either separator.
  const base = romPath.slice(Math.max(romPath.lastIndexOf('/'), romPath.lastIndexOf('\\')) + 1)
  const bytes = new TextEncoder().encode(base)
  let name = base
  if (bytes.length > FLYCAST_BASE_NAME_BYTES - 1) {
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, FLYCAST_BASE_NAME_BYTES - 1)
      )
    } catch {
      return null
    }
  }
  const dot = name.lastIndexOf('.')
  const content = dot === -1 ? name : name.slice(0, dot)
  return content === '' ? 'vmu_save' : content
}

/** What deciding on a first-launch VMU needs to know. */
export interface DreamcastSeedInput {
  /** `reicast_per_content_vmus` as RetroArch will hand it to the core. */
  option: string | null
  /** The product number RomM read out of the disc. */
  key: string | null
  romPath: string
  /** The folder the core is told to save in. */
  saveDir: string
  /** The folder the core is told holds its system files. */
  systemDir: string
}

/**
 * The shared VMU, copied in as the game's own the first time it runs with a
 * VMU of its own.
 *
 * With per-game VMUs on, Flycast opens `<product>.A1.bin` and, where that is
 * missing, a file named after the content — the name it used before it read
 * the product number. It loads that one, writes the product-named file and
 * deletes it (`getVmuPath` in `oslib.cpp`, `maple_devs.cpp`). A game that has
 * neither would start on an empty VMU, and everything saved on the shared
 * `vmu_save_A1.bin` so far would be out of its sight. Copying the shared VMU to
 * the old name hands it to Flycast once, through its own path, and the game's
 * VMU from then on is its own.
 *
 * Null while port A1 is still the shared VMU: nothing is missing then.
 */
export function dreamcastSeed(input: DreamcastSeedInput): SaveSeed | null {
  if (input.option === null || !PER_CONTENT_A1.has(input.option)) return null
  if (ARCADE.test(input.romPath)) {
    return { skipped: 'Flycast runs this kind of file as an arcade board, which has no VMU' }
  }
  const own = input.key ? dreamcastVmuName(input.key) : null
  if (!own) return { skipped: "RomM sent no product number to tell the game's own VMU by" }
  const content = flycastContentName(input.romPath)
  if (!content) return { skipped: 'Flycast cuts the ROM name inside a character' }
  return {
    from: joinPath(input.systemDir, 'dc', 'vmu_save_A1.bin'),
    to: joinPath(input.saveDir, `${content}.A1.bin`),
    unless: [joinPath(input.saveDir, own)]
  }
}
