import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EmulatorState } from '@config/emulators'
import type { SaveSetupReport } from '@shared/types'
import { carrying } from './host.ts'
import { SaveSetup, SAVE_SETUP_FILE } from './savesetup.ts'

/**
 * The save-setup check against a real disk: the report bazzite-maint reads, and
 * a fix into a file that belongs to another program.
 *
 * The edit itself is `retrodeck/savesetup.test.ts`'s. What is here is what the
 * adapter adds and what could hurt: that a fix changes one line and copies the
 * file first, that a second fix changes and copies nothing, that it will not
 * write while the emulator runs, through a link, or into a file the emulator
 * has not written yet — and that the report on disk is the report returned.
 */

const scratches: string[] = []
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CORE_OPTIONS = readFileSync(
  new URL('../config/emulators/retrodeck/fixtures/retroarch-core-options.cfg', import.meta.url),
  'utf8'
)

function rig(
  options: {
    running?: string[]
    playing?: boolean
    files?: Record<string, string>
  } = {}
): { setup: SaveSetup; config: string; rommix: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'rommix-savesetup-test-'))
  scratches.push(root)
  const config = join(root, 'config')
  const home = join(root, 'retrodeck')
  const rommix = join(root, 'rommix-config')
  const files = {
    'retroarch/retroarch-core-options.cfg': CORE_OPTIONS,
    'retroarch/retroarch.cfg': 'sort_savefiles_by_content_enable = "true"\n',
    'dolphin-emu/Dolphin.ini': '[Core]\nSlotB = 255\n\n[Display]\nFullscreen = True\n',
    ...options.files
  }
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(config, path, '..'), { recursive: true })
    writeFileSync(join(config, path), contents)
  }
  const state = {
    id: 'retrodeck',
    available: true,
    install: null,
    configDir: config,
    dataDir: null,
    paths: { home, roms: join(home, 'roms'), saves: join(home, 'saves'), states: null, bios: null }
  } as unknown as EmulatorState
  const setup = new SaveSetup({
    emulators: async () => [state],
    playing: () => options.playing ?? false,
    running: async () => options.running ?? [],
    configDir: rommix,
    version: () => '0.21.0-test',
    now: () => new Date('2026-09-30T20:00:00Z')
  })
  return { setup, config, rommix, home }
}

function item(report: SaveSetupReport | null, id: string) {
  const found = report?.items.find((one) => one.id === id)
  assert.ok(found, id)
  return found
}

describe('the report', () => {
  test('is written where bazzite-maint reads it, and is the report returned', async () => {
    const { setup, rommix, config } = rig()
    const report = await setup.check()

    const written = JSON.parse(
      readFileSync(join(rommix, SAVE_SETUP_FILE), 'utf8')
    ) as SaveSetupReport
    assert.deepEqual(written, report)
    assert.equal(written.schema, 1)
    assert.equal(written.rommix, '0.21.0-test')
    assert.equal(written.checkedAt, '2026-09-30T20:00:00.000Z')
    assert.equal(written.emulator, 'retrodeck')
    assert.deepEqual(item(written, 'flycast.perContentVmu'), {
      id: 'flycast.perContentVmu',
      file: join(config, 'retroarch/retroarch-core-options.cfg'),
      format: 'cfg',
      section: null,
      key: 'reicast_per_content_vmus',
      wanted: 'VMU A1',
      found: 'disabled',
      status: 'drift',
      fix: 'edit',
      reason: item(written, 'flycast.perContentVmu').reason
    })
    assert.match(item(written, 'flycast.perContentVmu').reason, /VMU A1/)
    assert.equal(item(written, 'duckstation.perGameCard').status, 'missing-file')
    assert.deepEqual(readdirSync(rommix), [SAVE_SETUP_FILE])
  })

  test(
    'a file that is there and cannot be read says so',
    { skip: process.getuid?.() === 0 },
    async () => {
      const { setup, config } = rig({ files: { 'duckstation/settings.ini': '[MemoryCards]\n' } })
      chmodSync(join(config, 'duckstation/settings.ini'), 0o000)
      assert.equal(item(await setup.check(), 'duckstation.perGameCard').status, 'unreadable')
    }
  )

  test('no RetroDECK, no report, and none written', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'rommix-savesetup-test-'))
    scratches.push(configDir)
    const setup = new SaveSetup({
      emulators: async () => [],
      playing: () => false,
      running: async () => [],
      configDir,
      version: () => 'x'
    })
    assert.equal(await setup.check(), null)
    assert.deepEqual(readdirSync(configDir), [])
  })
})

describe('a fix', () => {
  test('changes the one line, after a copy of the file is kept', async () => {
    const { setup, config, rommix } = rig()
    const file = join(config, 'retroarch/retroarch-core-options.cfg')

    const report = await setup.fix('flycast.perContentVmu')

    assert.equal(item(report, 'flycast.perContentVmu').status, 'ok')
    const after = readFileSync(file, 'utf8')
    const changed = CORE_OPTIONS.split('\n').filter((line, at) => line !== after.split('\n')[at])
    assert.deepEqual(changed, ['reicast_per_content_vmus = "disabled"'])
    const copy = join(
      rommix,
      'emulator-backups',
      'retroarch',
      'retroarch',
      'retroarch-core-options.cfg.1'
    )
    assert.equal(readFileSync(copy, 'utf8'), CORE_OPTIONS)
  })

  test('a second time writes nothing and copies nothing', async () => {
    const { setup, config, rommix } = rig()
    await setup.fix('flycast.perContentVmu')
    const file = join(config, 'retroarch/retroarch-core-options.cfg')
    const before = statSync(file).mtimeMs
    const copies = readdirSync(join(rommix, 'emulator-backups', 'retroarch', 'retroarch'))

    await setup.fix('flycast.perContentVmu')

    assert.equal(statSync(file).mtimeMs, before)
    assert.deepEqual(
      readdirSync(join(rommix, 'emulator-backups', 'retroarch', 'retroarch')),
      copies
    )
  })

  test('a key its section lacks is added to the section', async () => {
    const { setup, config } = rig()
    await setup.fix('dolphin.gciFolder')
    assert.equal(
      readFileSync(join(config, 'dolphin-emu/Dolphin.ini'), 'utf8'),
      '[Core]\nSlotB = 255\nSlotA = 8\n\n[Display]\nFullscreen = True\n'
    )
  })

  test('keeps the file’s permissions', async () => {
    const { setup, config } = rig()
    const file = join(config, 'dolphin-emu/Dolphin.ini')
    chmodSync(file, 0o640)
    await setup.fix('dolphin.gciFolder')
    assert.equal(statSync(file).mode & 0o777, 0o640)
  })

  test('is refused while RetroDECK runs, and while a game does', async () => {
    for (const busy of [
      { running: ['4242 bwrap --args 40 net.retrodeck.retrodeck'] },
      { playing: true }
    ]) {
      const { setup, config } = rig(busy)
      await assert.rejects(setup.fix('flycast.perContentVmu'), /Close RetroDECK/)
      assert.equal(
        readFileSync(join(config, 'retroarch/retroarch-core-options.cfg'), 'utf8'),
        CORE_OPTIONS
      )
    }
  })

  test('is refused through a link', async () => {
    const { setup, config } = rig()
    const real = join(config, 'elsewhere.ini')
    writeFileSync(real, '[Core]\nSlotA = 1\n')
    rmSync(join(config, 'dolphin-emu/Dolphin.ini'))
    symlinkSync(real, join(config, 'dolphin-emu/Dolphin.ini'))

    await assert.rejects(setup.fix('dolphin.gciFolder'), /link/)
    assert.equal(readFileSync(real, 'utf8'), '[Core]\nSlotA = 1\n')
  })

  test('does not create an emulator’s config the emulator has not written', async () => {
    const { setup, config } = rig()
    rmSync(join(config, 'dolphin-emu/Dolphin.ini'))
    await assert.rejects(setup.fix('dolphin.gciFolder'), /not there yet/)
    assert.equal(existsSync(join(config, 'dolphin-emu/Dolphin.ini')), false)
  })

  test('creates the ES-DE gamelist a system without games has not got yet', async () => {
    const { setup, home } = rig()
    await setup.fix('esde.component.psx')
    assert.match(
      readFileSync(join(home, 'ES-DE/gamelists/psx/gamelist.xml'), 'utf8'),
      /<label>SwanStation<\/label>/
    )
  })

  test('of a setting that is only reported, or of none at all, is refused', async () => {
    const { setup } = rig()
    await assert.rejects(setup.fix('pcsx2.cardIsFolder'), /not a setting RomMix can change/)
    await assert.rejects(setup.fix('no.such.rule'), /not a setting RomMix can change/)
  })
})

test('the running check finds the sandbox by its id and never itself or ps', () => {
  const ps = [
    '  100 /usr/bin/bwrap --args 42 -- net.retrodeck.retrodeck',
    '  200 /app/bin/pcsx2-qt',
    '  300 ps -eo pid=,args=',
    '  400 /tmp/.mount_RomMix/rommix --check net.retrodeck.retrodeck'
  ].join('\n')
  assert.deepEqual(carrying(ps, 'net.retrodeck.retrodeck', 400), [
    '100 /usr/bin/bwrap --args 42 -- net.retrodeck.retrodeck'
  ])
})

test('two checks at once leave one whole report', async () => {
  const { setup, rommix } = rig()
  await Promise.all([setup.check(), setup.check(), setup.check()])
  assert.equal(JSON.parse(readFileSync(join(rommix, SAVE_SETUP_FILE), 'utf8')).schema, 1)
  assert.deepEqual(readdirSync(rommix), [SAVE_SETUP_FILE])
})
