import { cfgValue } from '../ini.ts'
import { joinPath } from '../savepaths.ts'
import type { SaveEnvironment } from '../savepaths.ts'

/**
 * Where RetroDECK's RetroArch keeps the Flycast core's options, below the
 * flatpak's config root, and the one of them saves depend on.
 */
export const CORE_OPTIONS = 'retroarch/retroarch-core-options.cfg'
/** Where RetroArch keeps Flycast's overrides: a folder named after the core. */
export const FLYCAST_OVERRIDES = 'retroarch/config/Flycast'
export const VMU_KEY = 'reicast_per_content_vmus'

/**
 * The options files RetroArch reads Flycast's options from for one game, in
 * the order it looks: the first that exists is the one read.
 *
 * The game's own (`<content>.opt`, the ROM's name minus its extension) and
 * the folder's (`<folder>.opt`, the folder the ROM sits in) come first either
 * way. After them, with `global_core_options` on, only the global
 * `retroarch-core-options.cfg`; with it off, the core's `Flycast.opt`, and the
 * global file where that is not there yet, which is where RetroArch takes a
 * core's first values from (`core_option_manager_new`).
 */
export function flycastOptionFiles(
  configDir: string,
  romStem: string,
  romFolder: string,
  globalCoreOptions: boolean
): string[] {
  const overrides = joinPath(configDir, FLYCAST_OVERRIDES)
  return [
    joinPath(overrides, `${romStem}.opt`),
    joinPath(overrides, `${romFolder}.opt`),
    ...(globalCoreOptions ? [] : [joinPath(overrides, 'Flycast.opt')]),
    joinPath(configDir, CORE_OPTIONS)
  ]
}

/**
 * `reicast_per_content_vmus` as RetroArch will hand it to Flycast for one game,
 * from the first of `flycastOptionFiles` that exists. A file that exists and
 * leaves the key out means the core's default, which is off.
 */
export function flycastVmuOption(env: SaveEnvironment, files: readonly string[]): string | null {
  for (const file of files) {
    const text = env.text(file)
    if (text !== null) return cfgValue(text, VMU_KEY)
  }
  return null
}
