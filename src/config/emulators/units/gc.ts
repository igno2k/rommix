import type { SaveEnvironment, SaveUnit } from '../savepaths.ts'
import { joinPath } from '../savepaths.ts'
import { gciGameId, gciNameGameId } from './keys.ts'

/**
 * One GameCube game's saves in a Dolphin GCI folder.
 *
 * With a slot set to "GCI Folder" Dolphin keeps each save as one `.gci` file —
 * a memory-card directory entry and the save's blocks — in a folder per region
 * and card. A game owns the `.gci` files whose header names its disc id. The
 * id Dolphin writes into the file name is the same one and stands in only when
 * the header cannot be read.
 *
 * A file marked `.deleted` is skipped, as Argosy's `GciSaveHandler` skips it:
 * Dolphin loads only names ending `.gci`, so it is no save the game would see.
 */

/** How much of a `.gci` the rule reads: the game and maker codes. */
const GCI_HEAD_BYTES = 6

/**
 * The folder Dolphin keeps a region's cards in, from the last letter of the
 * disc's game code.
 *
 * Dolphin picks it by the disc's region, which the code's last letter states
 * for every retail disc: `E` North America, `J` Japan, and Korea filed with
 * Japan, the GameCube having no Korean memory-card region of its own. Every
 * other letter is a European country, and PAL.
 */
export function dolphinRegion(gameId: string): 'USA' | 'EUR' | 'JAP' {
  const region = gameId[3]
  if (region === 'E') return 'USA'
  if (region === 'J' || region === 'K') return 'JAP'
  return 'EUR'
}

export function gameCubeUnit(key: string, env: SaveEnvironment): SaveUnit {
  const wanted = key.toUpperCase()
  return {
    key: wanted,
    carriedAs: 'archive',
    owns: (name, kind, dir) => {
      if (kind !== 'file') return false
      const lower = name.toLowerCase()
      if (!lower.endsWith('.gci') || lower.includes('.deleted')) return false
      const id = gciGameId(env.head(joinPath(dir, name), GCI_HEAD_BYTES)) ?? gciNameGameId(name)
      // A four-character key is a game code without its maker, which is what a
      // server that knows the game but not the pressing sends.
      return id !== null && (wanted.length === 4 ? id.startsWith(wanted) : id === wanted)
    }
  }
}
