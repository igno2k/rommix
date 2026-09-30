import assert from 'node:assert/strict'
import { test } from 'node:test'
import { iniValue } from './ini.ts'

const INI = [
  '[EmuCore]',
  'McdFolderAutoManage = true',
  '; Slot1_Filename = commented.ps2',
  '[MemoryCards]',
  'Slot1_Enable = true',
  'Slot1_Filename = Mcd001.ps2',
  '',
  '[Other]',
  'Slot1_Filename = elsewhere.ps2'
].join('\r\n')

test('a value is read from its own section, whatever the case', () => {
  assert.equal(iniValue(INI, 'MemoryCards', 'Slot1_Filename'), 'Mcd001.ps2')
  assert.equal(iniValue(INI, 'memorycards', 'slot1_filename'), 'Mcd001.ps2')
  assert.equal(iniValue(INI, 'EmuCore', 'McdFolderAutoManage'), 'true')
})

test('a key that is absent, commented out or in another section is null', () => {
  assert.equal(iniValue(INI, 'EmuCore', 'Slot1_Filename'), null)
  assert.equal(iniValue(INI, 'Missing', 'Slot1_Filename'), null)
  assert.equal(iniValue(null, 'MemoryCards', 'Slot1_Filename'), null)
})
