import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { SaveUnit } from '../savepaths.ts'
import { ps2Stem, ps2Unit } from './ps2.ts'
import { PS2_CARD, PS2_KEY, PS2_OWNED, type FixtureTree } from './fixtures.ts'

/**
 * Which entries of a PCSX2 folder card are one game's.
 *
 * What is asserted is the whole card rather than the one entry: a rule that
 * claims one entry too many is a pull that writes into another game's save,
 * so the fixture holds a second game and the assertion is the exact list.
 */

/** What `unit` claims of the direct children of `tree`, sorted. */
function claimed(unit: SaveUnit, tree: FixtureTree): string[] {
  const seen = new Map<string, 'file' | 'dir'>()
  for (const path of Object.keys(tree)) {
    const [first, ...rest] = path.split('/')
    seen.set(first, rest.length > 0 ? 'dir' : 'file')
  }
  return [...seen]
    .filter(([name, kind]) => unit.owns(name, kind))
    .map(([name]) => name)
    .sort()
}

function unitOf(key: string): SaveUnit {
  const unit = ps2Unit(key)
  assert.ok(unit, key)
  return unit
}

describe('the serial', () => {
  test('a bare serial gains the region prefix its third letter names', () => {
    assert.equal(ps2Stem('SLUS-20152'), 'BASLUS20152')
    assert.equal(ps2Stem('SLES-50330'), 'BESLES50330')
    assert.equal(ps2Stem('SLPS_250.50'), 'BISLPS250.50')
    assert.equal(ps2Stem('SCKA-20010'), 'BISCKA20010')
    assert.equal(ps2Stem('scus-97328'), 'BASCUS97328')
  })

  test('a serial that already carries its prefix keeps it', () => {
    assert.equal(ps2Stem('BASLUS-20152'), 'BASLUS20152')
    assert.equal(ps2Stem('BESLES-50330'), 'BESLES50330')
  })

  test('something that is not a serial has no stem, rather than one matching everything', () => {
    for (const key of ['', '   ', 'Mcd001', 'BA', 'BASLUS', 'SLUS-', '20152']) {
      assert.equal(ps2Stem(key), null, key)
      assert.equal(ps2Unit(key), null, key)
    }
  })
})

describe('what a game owns', () => {
  test('every folder starting with the serial, and none of PCSX2’s, the console’s or the other game’s', () => {
    const unit = unitOf(PS2_KEY)
    assert.deepEqual(claimed(unit, PS2_CARD), [...PS2_OWNED].sort())
    assert.deepEqual([...unit.alsoAccepts].sort(), [
      'aethersx2',
      'armsx2',
      'armsx2_refresh',
      'nethersx2',
      'psx2'
    ])
  })

  test('folders are matched as Argosy matches them: no dash or underscore, any case', () => {
    const unit = unitOf(PS2_KEY)
    assert.equal(unit.owns('BASLUS_20152AC04', 'dir'), true)
    assert.equal(unit.owns('baslus-20152ac04', 'dir'), true)
    // Argosy's fallback: a folder written without the prefix, or under another one.
    assert.equal(unit.owns('SLUS-20152DATA', 'dir'), true)
    assert.equal(unit.owns('BESLUS-20152DATA', 'dir'), true)
    assert.equal(unit.owns('BASLUS-20153DATA', 'dir'), false)
    assert.equal(unit.owns('BESLES-50330DATA', 'dir'), false)
  })

  test('never a file, nor the console’s system and network folders', () => {
    const unit = unitOf(PS2_KEY)
    assert.equal(unit.owns('BASLUS-20152AC04', 'file'), false)
    assert.equal(unit.owns('_pcsx2_superblock', 'file'), false)
    for (const name of ['BADATA-SYSTEM', 'BIDATA-SYSTEM', 'BWNETCNF', 'BIWNETCNF']) {
      assert.equal(unit.owns(name, 'dir'), false, name)
    }
  })
})
