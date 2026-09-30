import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { SaveEnvironment } from '../savepaths.ts'
import { PS2_GAMEDB } from './fixtures.ts'
import { isGameDbTitle, memcardFiltersFor, parseGameDb, readGameDb, titleKey } from './gamedb.ts'

/**
 * Reading PCSX2's game database for the fields a folder card needs.
 *
 * The fixture is real entries, verbatim; the synthetic cases below it are the
 * shapes YAML allows that PCSX2's file does not use today, so a database
 * written by another tool is still read rather than silently emptied.
 */

describe('memcardFilters', () => {
  test('the filters of the entries that have them, keyed by the bare serial', () => {
    const db = parseGameDb(PS2_GAMEDB)
    assert.deepEqual(
      [...db].filter(([, entry]) => entry.filters.length > 0).map(([key, e]) => [key, e.filters]),
      [
        ['SCUS97268', ['SCUS-97268', 'SCUS-97199']],
        ['SLPM65495', ['BISLPM-65286NET', 'BWNETCNF', 'SLPM-65495']]
      ]
    )
  })

  test('a game is found by the serial with or without the card’s region prefix', () => {
    const db = parseGameDb(PS2_GAMEDB)
    assert.deepEqual(memcardFiltersFor(db, 'SCUS-97268'), ['SCUS-97268', 'SCUS-97199'])
    assert.deepEqual(memcardFiltersFor(db, 'BASCUS-97268'), ['SCUS-97268', 'SCUS-97199'])
    assert.deepEqual(memcardFiltersFor(db, 'scus_97268'), ['SCUS-97268', 'SCUS-97199'])
  })

  test('a game without filters, or not in the database, has none', () => {
    const db = parseGameDb(PS2_GAMEDB)
    assert.deepEqual(memcardFiltersFor(db, 'SLUS-20439'), [])
    assert.deepEqual(memcardFiltersFor(db, 'SLUS-99999'), [])
    assert.deepEqual(memcardFiltersFor(db, 'not a serial'), [])
  })

  test('a flow list, single quotes, comments and blank lines between items', () => {
    const db = parseGameDb(
      [
        'SLUS-00001:',
        '  memcardFilters: ["SLUS-00001", \'SLUS-00002\'] # both discs',
        'SLUS-00003:',
        '  name: "x"',
        '  memcardFilters: # a comment on the field',
        '    - SLUS-00003 # bare, with a comment',
        '',
        '    # a comment between items',
        "    - 'SLUS-00004'",
        '  region: "NTSC-U"',
        '    - "SLUS-99999"'
      ].join('\r\n')
    )
    assert.deepEqual(memcardFiltersFor(db, 'SLUS-00001'), ['SLUS-00001', 'SLUS-00002'])
    assert.deepEqual(memcardFiltersFor(db, 'SLUS-00003'), ['SLUS-00003', 'SLUS-00004'])
  })

  test('an empty filter is dropped, since it would match every folder', () => {
    const db = parseGameDb(
      ['SLUS-00001:', '  memcardFilters:', '    - ""', '    - "SLUS-00001"'].join('\n')
    )
    assert.deepEqual(memcardFiltersFor(db, 'SLUS-00001'), ['SLUS-00001'])
    const empty = parseGameDb(['SLUS-00002:', '  memcardFilters:', '    - ""'].join('\n'))
    assert.deepEqual(memcardFiltersFor(empty, 'SLUS-00002'), [])
  })

  test('a list at the end of the file is kept', () => {
    const db = parseGameDb('SLUS-00001:\n  memcardFilters:\n    - "SLUS-00002"')
    assert.deepEqual(memcardFiltersFor(db, 'SLUS-00001'), ['SLUS-00002'])
  })

  test('a field outside any entry, or under a key that is no serial, is ignored', () => {
    assert.equal(parseGameDb('  memcardFilters:\n    - "SLUS-00001"\n').size, 0)
    assert.equal(parseGameDb('Settings:\n  memcardFilters:\n    - "SLUS-00001"\n').size, 0)
  })
})

describe('which game a serial is', () => {
  const db = parseGameDb(PS2_GAMEDB)

  test('a title loses its region, its dump flags, a leading or trailing "The" and punctuation', () => {
    assert.equal(titleKey('Half-Life (USA)'), 'halflife')
    assert.equal(titleKey('Half-Life (USA) (Rev 1) [!]'), 'halflife')
    assert.equal(
      titleKey('Legend of Spyro, The - Dawn of the Dragon (USA)'),
      titleKey('The Legend of Spyro - Dawn of the Dragon')
    )
    assert.equal(titleKey('モンスターハンター'), '')
  })

  test('the ROM named as the database names the serial is that game', () => {
    assert.equal(isGameDbTitle(db, 'BASLUS-20066', 'Half-Life (USA)'), true)
    assert.equal(isGameDbTitle(db, 'SLUS-20439', 'Futurama (USA)'), true)
    // By `name-sort`, the way Redump names it.
    assert.equal(
      isGameDbTitle(db, 'SLUS-21820', 'Legend of Spyro, The - Dawn of the Dragon (USA)'),
      true
    )
    // By `name-en`, for an entry whose `name` is in kana.
    assert.equal(isGameDbTitle(db, 'SLPM-65495', 'Monster Hunter (Japan)'), true)
  })

  test('another ROM under the same serial is not, and neither is anything the database cannot name', () => {
    assert.equal(isGameDbTitle(db, 'BASLUS-20066', 'Half-Life - Blue Shift (USA)'), false)
    assert.equal(isGameDbTitle(db, 'SLUS-99999', 'Half-Life (USA)'), false)
    assert.equal(isGameDbTitle(db, 'SLPM-65495', 'モンスターハンター'), false)
    assert.equal(isGameDbTitle(db, 'BASLUS-20066', '(USA)'), false)
  })
})

describe('reading the database', () => {
  /** A machine with one file, counting how often it is read. */
  function machine(files: Record<string, string>): SaveEnvironment & { reads: number } {
    const env = {
      reads: 0,
      exists: (path: string) => path in files,
      dirs: () => [],
      files: () => [],
      text: (path: string) => {
        env.reads += 1
        return files[path] ?? null
      },
      head: () => null,
      newest: () => 0
    }
    return env
  }

  test('read once per environment', () => {
    const env = machine({ '/db/GameIndex.yaml': PS2_GAMEDB })
    const first = readGameDb(env, '/db/GameIndex.yaml')
    const second = readGameDb(env, '/db/GameIndex.yaml')
    assert.ok(first)
    assert.equal(second, first)
    assert.equal(env.reads, 1)
    // Another machine reads its own.
    const other = machine({ '/db/GameIndex.yaml': PS2_GAMEDB })
    assert.ok(readGameDb(other, '/db/GameIndex.yaml'))
    assert.equal(other.reads, 1)
  })

  test('missing is null, and asked again next time', () => {
    const env = machine({})
    assert.equal(readGameDb(env, '/db/GameIndex.yaml'), null)
    assert.equal(readGameDb(env, '/db/GameIndex.yaml'), null)
    assert.equal(env.reads, 2)
  })

  test('a file with no entry in it is not PCSX2’s database', () => {
    const env = machine({ '/db/GameIndex.yaml': 'this is not YAML at all\n\u0000\u0001' })
    assert.equal(readGameDb(env, '/db/GameIndex.yaml'), null)
  })
})
