import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { EmulatorState } from '../types.ts'
import { treeEnvironment } from '../units/fixtures.ts'
import { PCSX2_BUSY } from './saves.ts'
import { checkSaveSetup, saveSetupTarget, setIniValue } from './savesetup.ts'
import type { SaveSetupFinding } from './savesetup.ts'

/** The PCSX2 settings PS2 save sync depends on, read off a described RetroDECK. */

const CONFIG = '/var/rd/config'
const SAVES = '/home/deck/retrodeck/saves'
const INI = `${CONFIG}/PCSX2/inis/PCSX2.ini`
const CARD = `${SAVES}/ps2/pcsx2/memcards/Mcd001.ps2/_pcsx2_superblock`

function check(files: Record<string, string>): Record<string, SaveSetupFinding> {
  const env = treeEnvironment({
    '': Object.fromEntries(Object.entries(files).map(([p, c]) => [p.slice(1), c]))
  })
  const findings = checkSaveSetup({ configDir: CONFIG, saves: SAVES, busy: PCSX2_BUSY, env })
  return Object.fromEntries(findings.map((finding) => [finding.id, finding]))
}

const INI_AS_SHIPPED =
  '[EmuCore]\nMcdFolderAutoManage = true\n\n[MemoryCards]\nSlot1_Filename = Mcd001.ps2\n'

describe('checking', () => {
  test('RetroDECK as it ships: a folder card in slot 1, managed per game', () => {
    const found = check({ [INI]: INI_AS_SHIPPED, [CARD]: 'superblock' })
    assert.equal(found['pcsx2.folderAutoManage'].status, 'ok')
    assert.equal(found['pcsx2.cardIsFolder'].status, 'ok')
    assert.equal(found['pcsx2.cardIsFolder'].found, 'Mcd001.ps2')
    assert.equal(found['pcsx2.folderAutoManage'].file, INI)
  })

  test('management is off only where PCSX2 would read the value as false', () => {
    for (const [value, status] of [
      ['false', 'off'],
      ['FALSE', 'off'],
      ['0', 'off'],
      ['no', 'off'],
      ['off', 'off'],
      ['disabled', 'off'],
      ['true', 'ok'],
      ['1', 'ok'],
      ['yes', 'ok'],
      // Neither, so PCSX2 keeps its default, which is on.
      ['sometimes', 'ok']
    ] as const) {
      const found = check({
        [INI]: `[EmuCore]\nMcdFolderAutoManage = ${value}\n`,
        [CARD]: 'superblock'
      })
      assert.equal(found['pcsx2.folderAutoManage'].status, status, value)
    }
    // A key or a file that is not there is PCSX2's default.
    assert.equal(check({ [CARD]: 'superblock' })['pcsx2.folderAutoManage'].status, 'ok')
  })

  test('only management is RomMix’s to set; the card is a person’s to convert', () => {
    const found = check({ [INI]: '[EmuCore]\nMcdFolderAutoManage = false\n' })
    assert.equal(found['pcsx2.folderAutoManage'].wanted, 'true')
    assert.equal(found['pcsx2.cardIsFolder'].wanted, undefined)
  })

  test('a raw card in slot 1 is off, to be converted', () => {
    const raw = check({
      [INI]: '[MemoryCards]\nSlot1_Filename = Mcd001.ps2\n',
      [`${SAVES}/ps2/pcsx2/memcards/Mcd001.ps2`]: 'an 8 MB image'
    })
    assert.equal(raw['pcsx2.cardIsFolder'].status, 'off')
    assert.equal(raw['pcsx2.cardIsFolder'].reason, 'saveSetup.pcsx2CardIsFolder')
    // Without the ini, Mcd001.ps2, as PCSX2 reads it.
    assert.equal(check({ [CARD]: 'superblock' })['pcsx2.cardIsFolder'].status, 'ok')
  })

  test('none at all is off, and says to create a folder card', () => {
    const none = check({ [INI]: INI_AS_SHIPPED })['pcsx2.cardIsFolder']
    assert.equal(none.status, 'off')
    assert.equal(none.reason, 'saveSetup.pcsx2NoCard')
    assert.equal(check({})['pcsx2.cardIsFolder'].reason, 'saveSetup.pcsx2NoCard')
  })

  test('the card is looked for where [Folders] MemoryCards says, as in PCSX2', () => {
    // Absolute as it is; relative below PCSX2's data folder, the one `inis` is in.
    for (const [named, folder] of [
      ['/run/media/deck/sd/memcards', '/run/media/deck/sd/memcards'],
      ['cards', `${CONFIG}/PCSX2/cards`]
    ]) {
      const ini = `[Folders]\nMemoryCards = ${named}\n`
      const found = check({ [INI]: ini, [`${folder}/Mcd001.ps2/_pcsx2_superblock`]: 'superblock' })
      assert.equal(found['pcsx2.cardIsFolder'].status, 'ok', named)
      // The folder RetroDECK would use is not the one PCSX2 reads.
      assert.equal(check({ [INI]: ini, [CARD]: 'superblock' })['pcsx2.cardIsFolder'].status, 'off')
    }
  })
})

describe('setting a value', () => {
  test('in place, keeping the spacing, the line endings and every other byte', () => {
    assert.equal(
      setIniValue(
        '[EmuCore]\r\nMcdFolderAutoManage=false\r\nOther = 1\r\n',
        'EmuCore',
        'McdFolderAutoManage',
        'true'
      ),
      '[EmuCore]\r\nMcdFolderAutoManage=true\r\nOther = 1\r\n'
    )
    assert.equal(
      setIniValue(
        '[emucore]\nmcdfolderautomanage   =   false\n',
        'EmuCore',
        'McdFolderAutoManage',
        'true'
      ),
      '[emucore]\nmcdfolderautomanage   =   true\n'
    )
  })

  test('a commented line or another section’s key is not the one set', () => {
    assert.equal(
      setIniValue(
        '[Other]\nMcdFolderAutoManage = false\n[EmuCore]\n; McdFolderAutoManage = false\nA = 1\n\n[Next]\n',
        'EmuCore',
        'McdFolderAutoManage',
        'true'
      ),
      '[Other]\nMcdFolderAutoManage = false\n[EmuCore]\n; McdFolderAutoManage = false\nA = 1\nMcdFolderAutoManage = true\n\n[Next]\n'
    )
  })

  test('a section the file lacks goes at the end', () => {
    assert.equal(
      setIniValue('[A]\nx = 1\n', 'EmuCore', 'K', 'v'),
      '[A]\nx = 1\n\n[EmuCore]\nK = v\n'
    )
    assert.equal(setIniValue('[A]\nx = 1', 'EmuCore', 'K', 'v'), '[A]\nx = 1\n\n[EmuCore]\nK = v\n')
    assert.equal(setIniValue('', 'EmuCore', 'K', 'v'), '[EmuCore]\nK = v\n')
  })

  test('setting it twice is setting it once', () => {
    const once = setIniValue(
      INI_AS_SHIPPED.replace('true', 'false'),
      'EmuCore',
      'McdFolderAutoManage',
      'true'
    )
    assert.equal(once, INI_AS_SHIPPED)
    assert.equal(setIniValue(once, 'EmuCore', 'McdFolderAutoManage', 'true'), once)
  })
})

test('only an installed RetroDECK with a config root is checked', () => {
  const env = treeEnvironment({})
  const state = (fields: Partial<EmulatorState>): EmulatorState =>
    ({
      id: 'retrodeck',
      available: true,
      configDir: CONFIG,
      paths: { saves: SAVES },
      ...fields
    }) as EmulatorState
  assert.deepEqual(saveSetupTarget([state({})], env), {
    configDir: CONFIG,
    saves: SAVES,
    busy: PCSX2_BUSY,
    env
  })
  assert.equal(saveSetupTarget([state({ available: false })], env), null)
  assert.equal(saveSetupTarget([state({ configDir: null })], env), null)
  assert.equal(saveSetupTarget([state({ id: 'emudeck' })], env), null)
})
