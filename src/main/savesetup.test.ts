import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EmulatorState } from '@config/emulators'
import type { SaveSetupItem } from '@shared/types'
import { SaveSetup } from './savesetup.ts'

/**
 * The PCSX2 settings check against a real disk, and a fix into a file that
 * belongs to another program.
 *
 * The edit itself is `retrodeck/savesetup.test.ts`'s. What is here is what the
 * adapter adds and what could hurt: that a fix changes one line and copies the
 * file first, that a second fix changes and copies nothing, and that it will
 * not write while the emulator runs or through a link.
 */

const scratches: string[] = []
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const INI =
  '[UI]\nMainWindowGeometry = abc\n\n[EmuCore]\nMcdFolderAutoManage = false\nEnableCheats = false\n\n[MemoryCards]\nSlot1_Filename = Mcd001.ps2\n'

function rig(options: { running?: string[]; playing?: boolean; retrodeck?: boolean } = {}): {
  setup: SaveSetup
  ini: string
  rommix: string
} {
  const root = mkdtempSync(join(tmpdir(), 'rommix-savesetup-test-'))
  scratches.push(root)
  const config = join(root, 'config')
  const saves = join(root, 'retrodeck', 'saves')
  const ini = join(config, 'PCSX2', 'inis', 'PCSX2.ini')
  mkdirSync(join(ini, '..'), { recursive: true })
  writeFileSync(ini, INI)
  mkdirSync(join(saves, 'ps2', 'pcsx2', 'memcards', 'Mcd001.ps2'), { recursive: true })
  writeFileSync(join(saves, 'ps2', 'pcsx2', 'memcards', 'Mcd001.ps2', '_pcsx2_superblock'), '')
  const state = {
    id: 'retrodeck',
    available: options.retrodeck ?? true,
    configDir: config,
    paths: { saves }
  } as unknown as EmulatorState
  const rommix = join(root, 'rommix-config')
  const setup = new SaveSetup({
    emulators: async () => [state],
    playing: () => options.playing ?? false,
    running: async () => options.running ?? [],
    configDir: rommix
  })
  return { setup, ini, rommix }
}

function item(items: readonly SaveSetupItem[] | null, id: string): SaveSetupItem {
  const found = items?.find((one) => one.id === id)
  assert.ok(found, id)
  return found
}

test('the check says what is off, in the language RomMix is set to', async () => {
  const { setup, ini } = rig()
  const items = await setup.check()
  assert.deepEqual(item(items, 'pcsx2.folderAutoManage'), {
    id: 'pcsx2.folderAutoManage',
    file: ini,
    key: 'McdFolderAutoManage',
    found: 'false',
    status: 'off',
    wanted: 'true',
    reason: item(items, 'pcsx2.folderAutoManage').reason
  })
  assert.match(item(items, 'pcsx2.folderAutoManage').reason, /per game/)
  assert.equal(item(items, 'pcsx2.cardIsFolder').status, 'ok')
  assert.equal(item(items, 'pcsx2.cardIsFolder').wanted, null)
  assert.equal(await rig({ retrodeck: false }).setup.check(), null)
})

describe('a fix', () => {
  test('changes the one line, after a copy of the file is kept', async () => {
    const { setup, ini, rommix } = rig()
    chmodSync(ini, 0o640)
    const items = await setup.fix('pcsx2.folderAutoManage')

    assert.equal(item(items, 'pcsx2.folderAutoManage').status, 'ok')
    assert.equal(
      readFileSync(ini, 'utf8'),
      INI.replace('McdFolderAutoManage = false', 'McdFolderAutoManage = true')
    )
    assert.equal(statSync(ini).mode & 0o777, 0o640)
    assert.equal(readFileSync(join(rommix, 'emulator-backups', 'PCSX2.ini.1'), 'utf8'), INI)
    // Nothing left beside the file.
    assert.deepEqual(readdirSync(join(ini, '..')), ['PCSX2.ini'])
  })

  test('a second time writes nothing and copies nothing', async () => {
    const { setup, ini, rommix } = rig()
    await setup.fix('pcsx2.folderAutoManage')
    const before = statSync(ini).mtimeMs
    await setup.fix('pcsx2.folderAutoManage')
    assert.equal(statSync(ini).mtimeMs, before)
    assert.deepEqual(readdirSync(join(rommix, 'emulator-backups')), ['PCSX2.ini.1'])
  })

  test('is refused while RetroDECK runs, and while a game does', async () => {
    for (const busy of [{ running: ['flatpak net.retrodeck.retrodeck'] }, { playing: true }]) {
      const { setup, ini } = rig(busy)
      await assert.rejects(setup.fix('pcsx2.folderAutoManage'), /Close RetroDECK/)
      assert.equal(readFileSync(ini, 'utf8'), INI)
    }
  })

  test('is refused through a link', async () => {
    const { setup, ini } = rig()
    const real = join(ini, '..', 'elsewhere.ini')
    writeFileSync(real, INI)
    rmSync(ini)
    symlinkSync(real, ini)
    await assert.rejects(setup.fix('pcsx2.folderAutoManage'), /link/)
    assert.equal(readFileSync(real, 'utf8'), INI)
  })

  test('of the card, which is a person’s to convert, or of nothing at all, is refused', async () => {
    const { setup, ini } = rig()
    await assert.rejects(setup.fix('pcsx2.cardIsFolder'), /not a setting RomMix can change/)
    await assert.rejects(setup.fix('no.such.rule'), /not a setting RomMix can change/)
    await assert.rejects(rig({ retrodeck: false }).setup.fix('pcsx2.folderAutoManage'))
    assert.equal(readFileSync(ini, 'utf8'), INI)
  })
})
