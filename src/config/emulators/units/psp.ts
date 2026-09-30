import type { SaveEnvironment, SaveUnit } from '../savepaths.ts'
import { joinPath } from '../savepaths.ts'
import { normalizeForMatch, paramSfoKeys, pspDiscId, PARAM_SFO_HEAD_BYTES } from './keys.ts'

/**
 * One PSP game's saves in PPSSPP's `SAVEDATA`.
 *
 * Every save is a folder named after the disc id and whatever the game adds —
 * `ULUS10064DATA00`, `ULUS10064SETTINGS` — so the id is a prefix of each of
 * them. The same folder also takes a game's *installed data*, the part of the
 * disc some games copy to the memory stick to load faster, under the same kind
 * of name. That is not a save and can run to hundreds of megabytes, so it is
 * left out: a folder whose PARAM.SFO can be read and declares neither of the
 * keys every save's does is game data. A folder whose PARAM.SFO cannot be read
 * is kept, which is what Argosy's `PrefixBundleFolderHandler` decides too.
 */

/** Keys only a save's PARAM.SFO declares. */
const SAVE_KEYS: readonly string[] = ['SAVEDATA_PARAMS', 'SAVEDATA_FILE_LIST']

/** The tag Argosy uploads a PSP save under from PPSSPP Gold, the same program. */
export const PSP_FORK_TAGS: readonly string[] = ['ppsspp_gold']

export function pspUnit(key: string, env: SaveEnvironment): SaveUnit | null {
  const id = pspDiscId(key)
  if (!id) return null
  return {
    key: id,
    carriedAs: 'archive',
    owns: (name, kind, dir) => {
      if (kind !== 'dir') return false
      if (!normalizeForMatch(name).startsWith(id)) return false
      const keys = paramSfoKeys(env.head(joinPath(dir, name, 'PARAM.SFO'), PARAM_SFO_HEAD_BYTES))
      return keys === null || keys.some((one) => SAVE_KEYS.includes(one))
    },
    alsoAccepts: PSP_FORK_TAGS
  }
}
