import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { SaveEnvironment, SaveUnit } from '../savepaths.ts'
import { dreamcastSeed, dreamcastUnit, flycastContentName } from './dc.ts'
import { dolphinRegion, gameCubeUnit } from './gc.ts'
import {
  dreamcastVmuName,
  gameCubeId,
  gciGameId,
  gciNameGameId,
  normalizeForMatch,
  paramSfoKeys,
  ps2Stems,
  pspDiscId
} from './keys.ts'
import { ps2Unit, PS2_CARD_FILES } from './ps2.ts'
import { pspUnit } from './psp.ts'
import {
  DC_KEY,
  DC_OWNED,
  GCI_FOLDER,
  GC_KEY,
  GC_OWNED,
  PS2_CARD,
  PS2_KEY,
  PS2_OWNED,
  PSP_KEY,
  PSP_OWNED,
  SAVEDATA,
  VMU_DIR,
  gameCubeIso,
  gameCubeRvz,
  gci,
  paramSfo,
  treeEnvironment,
  type FixtureTree
} from './fixtures.ts'

/**
 * The rules that say which entries of a shared save folder are one game's.
 *
 * What is asserted is the whole folder rather than the one entry: a rule that
 * claims one entry too many is a pull that replaces another game's save, so
 * every fixture holds a second game and the assertion is the exact list.
 */

const ROOT = '/saves/shared'

/** The direct children of a fixture tree, with their kind. */
function entries(tree: FixtureTree): { name: string; kind: 'file' | 'dir' }[] {
  const seen = new Map<string, 'file' | 'dir'>()
  for (const path of Object.keys(tree)) {
    const [first, ...rest] = path.split('/')
    seen.set(first, rest.length > 0 ? 'dir' : 'file')
  }
  return [...seen].map(([name, kind]) => ({ name, kind }))
}

/** What `unit` claims of `tree`, sorted. */
function claimed(unit: SaveUnit, tree: FixtureTree): string[] {
  return entries(tree)
    .filter((entry) => unit.owns(entry.name, entry.kind, ROOT))
    .map((entry) => entry.name)
    .sort()
}

function env(tree: FixtureTree): SaveEnvironment {
  return treeEnvironment({ [ROOT]: tree })
}

describe('keys', () => {
  test('a name is reduced to its letters and digits, upper case', () => {
    assert.equal(normalizeForMatch('BASLUS-20152_ac04'), 'BASLUS20152AC04')
  })

  test('a bare PS2 serial gains the region prefix its third letter names', () => {
    assert.deepEqual(ps2Stems('SLUS-20152'), ['BASLUS20152', 'SLUS20152'])
    assert.deepEqual(ps2Stems('SLES-50330'), ['BESLES50330', 'SLES50330'])
    assert.deepEqual(ps2Stems('SLPS_250.50'), ['BISLPS25050', 'SLPS25050'])
    assert.deepEqual(ps2Stems('SCKA-20010'), ['BISCKA20010', 'SCKA20010'])
    assert.deepEqual(ps2Stems('SCUS-97328'), ['BASCUS97328', 'SCUS97328'])
  })

  test('a serial that already carries its prefix keeps it', () => {
    assert.deepEqual(ps2Stems('BASLUS-20152'), ['BASLUS20152', 'SLUS20152'])
  })

  test('something that is not a serial gives no stem, rather than one matching everything', () => {
    assert.deepEqual(ps2Stems(''), [])
    assert.deepEqual(ps2Stems('Mcd001'), [])
    assert.deepEqual(ps2Stems('BA'), [])
  })

  test('a GameCube id is read from a plain image and from an RVZ', () => {
    assert.equal(gameCubeId(gameCubeIso('GZLE01')), 'GZLE01')
    assert.equal(gameCubeId(gameCubeRvz('GM4P01')), 'GM4P01')
  })

  test('an image without the disc magic has no id, however it starts', () => {
    assert.equal(gameCubeId(`GZLE01${'\x00'.repeat(0x40)}`), null)
    assert.equal(gameCubeId(null), null)
    assert.equal(gameCubeId('gzle01'), null)
  })

  test('a GCI names its game in its header and, in Dolphin order, in its name', () => {
    assert.equal(gciGameId(gci('GZLE01', 'gczelda2', '')), 'GZLE01')
    assert.equal(gciGameId('\xFF\xFF'), null)
    assert.equal(gciNameGameId('01-GZLE-gczelda2.gci'), 'GZLE01')
    assert.equal(gciNameGameId('gczelda2.gci'), null)
  })

  test('a PSP disc id is four letters and five digits', () => {
    assert.equal(pspDiscId('ULUS-10064'), 'ULUS10064')
    assert.equal(pspDiscId('ULUS1006'), null)
  })

  test('the keys of a PARAM.SFO are read from its key table', () => {
    assert.deepEqual(paramSfoKeys(paramSfo(['CATEGORY', 'SAVEDATA_PARAMS'])), [
      'CATEGORY',
      'SAVEDATA_PARAMS'
    ])
    assert.equal(paramSfoKeys('not a PARAM.SFO'), null)
    assert.equal(paramSfoKeys('\x00PSF\x01\x01'), null)
  })

  test('a Dreamcast VMU is named the way Flycast names it', () => {
    assert.equal(dreamcastVmuName('MK-51035'), 'MK-51035.A1.bin')
    assert.equal(dreamcastVmuName('T-8101N   '), 'T-8101N.A1.bin')
    assert.equal(dreamcastVmuName('HDR 0001:*?'), 'HDR_0001___.A1.bin')
    assert.equal(dreamcastVmuName('a/b\\c|d<e>f'), 'a_b_c_d_e_f.A1.bin')
    assert.equal(dreamcastVmuName('   '), null)
  })
})

describe('what a game owns', () => {
  test('PS2: every folder starting with the serial, and none of PCSX2 or of the other game', () => {
    const unit = ps2Unit(PS2_KEY)
    assert.ok(unit)
    assert.deepEqual(claimed(unit, PS2_CARD), [...PS2_OWNED].sort())
    assert.equal(unit.carriedAs, 'archive')
    assert.deepEqual(unit.keepsHandsOff, PS2_CARD_FILES)
    assert.ok(unit.alsoAccepts?.includes('armsx2'))
  })

  test('PS2: a folder written without the region prefix is still the game', () => {
    const unit = ps2Unit(PS2_KEY)
    assert.ok(unit)
    assert.equal(unit.owns('SLUS-20152DATA', 'dir', ROOT), true)
    assert.equal(unit.owns('BESLES-50330DATA', 'dir', ROOT), false)
  })

  test('PS2: no key, no unit', () => {
    assert.equal(ps2Unit('not a serial'), null)
  })

  test('GameCube: the game’s .gci files by header, not the other game, not a deleted one', () => {
    const unit = gameCubeUnit(GC_KEY, env(GCI_FOLDER))
    assert.deepEqual(claimed(unit, GCI_FOLDER), [...GC_OWNED].sort())
  })

  test('GameCube: the header wins over a name that says otherwise', () => {
    const renamed: FixtureTree = { '01-GZLE-lies.gci': gci('GM4E8P', 'MarioKart', '') }
    assert.deepEqual(claimed(gameCubeUnit(GC_KEY, env(renamed)), renamed), [])
  })

  test('GameCube: a name stands in only where there is no header to read', () => {
    const unit = gameCubeUnit(GC_KEY, env({}))
    assert.equal(unit.owns('01-GZLE-gczelda2.gci', 'file', ROOT), true)
    assert.equal(unit.owns('8P-GM4E-mk.gci', 'file', ROOT), false)
    assert.equal(unit.owns('01-GZLE-gczelda2.gci', 'dir', ROOT), false)
  })

  test('GameCube: by name alone, only a name that names another game is ruled out', () => {
    const unit = gameCubeUnit(GC_KEY, env({}))
    assert.equal(unit.mayOwn?.('zelda.gci', 'file'), true)
    assert.equal(unit.mayOwn?.('01-GZLE-gczelda2.gci', 'file'), true)
    assert.equal(unit.mayOwn?.('8P-GM4E-kart.gci', 'file'), false)
    assert.equal(unit.mayOwn?.('zelda.sav', 'file'), false)
    assert.equal(unit.mayOwn?.('zelda.deleted.gci', 'file'), false)
    assert.equal(unit.mayOwn?.('Card A', 'dir'), false)
  })

  test('GameCube: a four-character key matches the game code of any maker', () => {
    const unit = gameCubeUnit('gzle', env(GCI_FOLDER))
    assert.deepEqual(claimed(unit, GCI_FOLDER), [...GC_OWNED].sort())
  })

  test('GameCube: the region folder follows the game code', () => {
    assert.equal(dolphinRegion('GZLE01'), 'USA')
    assert.equal(dolphinRegion('GZLP01'), 'EUR')
    assert.equal(dolphinRegion('GZLD01'), 'EUR')
    assert.equal(dolphinRegion('GZLJ01'), 'JAP')
    assert.equal(dolphinRegion('GZLK01'), 'JAP')
  })

  test('PSP: every save folder of the disc id, not its installed data, not the other game', () => {
    const unit = pspUnit(PSP_KEY, env(SAVEDATA))
    assert.ok(unit)
    assert.deepEqual(claimed(unit, SAVEDATA), [...PSP_OWNED].sort())
    assert.ok(unit.alsoAccepts?.includes('ppsspp_gold'))
  })

  test('PSP: a folder whose PARAM.SFO cannot be read is kept', () => {
    const tree: FixtureTree = { 'ULUS10064DATA02/DATA.BIN': 'no PARAM.SFO yet' }
    const unit = pspUnit(PSP_KEY, env(tree))
    assert.ok(unit)
    assert.deepEqual(claimed(unit, tree), ['ULUS10064DATA02'])
  })

  test('PSP: no key, no unit', () => {
    assert.equal(pspUnit('ULUS', env({})), null)
  })

  test('Dreamcast: the product-named A1 file, and nothing else', () => {
    const unit = dreamcastUnit(DC_KEY)
    assert.ok(unit)
    assert.deepEqual(claimed(unit, VMU_DIR), [...DC_OWNED])
    assert.equal(unit.carriedAs, 'file')
    assert.equal(unit.fileName, 'MK-51035.A1.bin')
  })

  test('Dreamcast: no key, no unit', () => {
    assert.equal(dreamcastUnit(' '), null)
  })
})

describe('the Dreamcast first-launch VMU', () => {
  test('the content name is the file name as Flycast cuts it', () => {
    assert.equal(flycastContentName('/roms/dreamcast/Crazy Taxi (USA).chd'), 'Crazy Taxi (USA)')
    assert.equal(flycastContentName('/roms/dreamcast/Game v1.1.gdi'), 'Game v1.1')
    assert.equal(flycastContentName('/roms/dreamcast/noext'), 'noext')
    assert.equal(flycastContentName('/roms/dreamcast/.gdi'), 'vmu_save')
    assert.equal(flycastContentName('C:\\roms\\Game.cdi'), 'Game')

    // 127 bytes of the name survive, and the last dot is looked for in those.
    const long = `${'A'.repeat(120)} v1.2 (Disc 1).chd`
    assert.equal(flycastContentName(`/r/${long}`), `${'A'.repeat(120)} v1`)
    // A cut inside a character leaves no name that can be written back.
    const wide = `${'A'.repeat(126)}\u00e9.chd`
    assert.equal(flycastContentName(`/r/${wide}`), null)
    // A cut after a whole character is fine.
    assert.equal(flycastContentName(`/r/${'A'.repeat(125)}\u00e9.chd`), `${'A'.repeat(125)}\u00e9`)
  })

  const input = {
    option: 'VMU A1',
    key: DC_KEY,
    romPath: '/rd/roms/dreamcast/Crazy Taxi (USA).chd',
    saveDir: '/rd/saves/dreamcast',
    systemDir: '/rd/bios'
  }

  test('the shared A1 VMU goes to the old name, unless the game has its own', () => {
    assert.deepEqual(dreamcastSeed(input), {
      from: '/rd/bios/dc/vmu_save_A1.bin',
      to: '/rd/saves/dreamcast/Crazy Taxi (USA).A1.bin',
      unless: ['/rd/saves/dreamcast/MK-51035.A1.bin']
    })
    assert.deepEqual(
      dreamcastSeed({ ...input, key: 'HDR 0001' }),
      dreamcastSeed({ ...input, key: 'HDR_0001' })
    )
  })

  test('nothing while A1 is the shared VMU, as Flycast compares the option', () => {
    for (const option of [null, 'disabled', 'vmu a1', 'VMU A1 ', 'All vmus']) {
      assert.equal(dreamcastSeed({ ...input, option }), null, String(option))
    }
    assert.ok(dreamcastSeed({ ...input, option: 'All VMUs' }))
  })

  test('the disc formats Flycast runs as a Dreamcast are seeded', () => {
    for (const ext of ['chd', 'cdi', 'gdi', 'cue', 'm3u', 'CHD']) {
      const seed = dreamcastSeed({ ...input, romPath: `/r/game.${ext}` })
      assert.ok(seed && 'from' in seed, ext)
    }
  })

  test('an arcade file, a missing key or an uncuttable name is skipped with a reason', () => {
    const arcade = ['/r/game.zip', '/r/game.7z', '/r/GAME.ZIP', '/r/a.lst', '/r/a.BIN', '/r/a.dat']
    for (const romPath of arcade) {
      const seed = dreamcastSeed({ ...input, romPath })
      assert.ok(seed && 'skipped' in seed, romPath)
    }
    for (const key of [null, '', '   ']) {
      const seed = dreamcastSeed({ ...input, key })
      assert.ok(seed && 'skipped' in seed, String(key))
    }
    const seed = dreamcastSeed({ ...input, romPath: `/r/${'A'.repeat(126)}\u00e9.chd` })
    assert.ok(seed && 'skipped' in seed)
  })
})
