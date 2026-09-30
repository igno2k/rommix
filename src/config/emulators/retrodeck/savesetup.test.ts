import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createI18n, localize } from '@shared/i18n'
import { treeEnvironment } from '../units/fixtures.ts'
import {
  applySaveSetupRule,
  cfgValue,
  evaluateSaveSetup,
  evaluateSaveSetupRule,
  gamelistGameLabels,
  gamelistSystemLabel,
  normalizeSetting,
  RETRODECK_SYSTEM_LABELS,
  SAVE_SETUP_RULES,
  setCfgValue,
  setGamelistSystemLabel,
  setIniValue,
  type SaveSetupContext,
  type SaveSetupRule
} from './savesetup.ts'

/**
 * The save-relevant settings of RetroDECK's emulators: what they are, and the
 * edits a confirmed fix makes.
 *
 * The two real files are bazzite-maint's fixtures, taken from a live RetroDECK
 * 0.10.9b — `PCSX2.ini` and `retroarch-core-options.cfg` as RetroDECK wrote
 * them. An edit is asserted as a diff of exactly the one line it is about,
 * because these are files the emulators rewrite and a person may have edited,
 * and a fix that reflows anything else is a fix nobody can review.
 */

const FIXTURES = new URL('./fixtures/', import.meta.url)
const PCSX2_INI = readFileSync(new URL('PCSX2.ini', FIXTURES), 'utf8')
const CORE_OPTIONS = readFileSync(new URL('retroarch-core-options.cfg', FIXTURES), 'utf8')

const CONFIG = '/home/deck/.var/app/net.retrodeck.retrodeck/config'
const RD = '/home/deck/retrodeck'
const ENGLISH = createI18n('en')

function rule(id: string): SaveSetupRule {
  const found = SAVE_SETUP_RULES.find((one) => one.id === id)
  assert.ok(found, id)
  return found
}

function context(
  files: Record<string, string> = {},
  installDir: string | null = null
): SaveSetupContext {
  const tree: Record<string, string> = {}
  for (const [path, contents] of Object.entries(files)) tree[path.slice(1)] = contents
  return {
    configDir: CONFIG,
    home: RD,
    saves: `${RD}/saves`,
    installDir,
    env: treeEnvironment({ '': tree })
  }
}

/** The lines that differ between two versions of one file, as [before, after]. */
function changedLines(before: string, after: string): [string, string][] {
  const a = before.split('\n')
  const b = after.split('\n')
  assert.equal(a.length, b.length, 'an edit that adds or drops lines')
  return a.flatMap((line, index) =>
    line === b[index] ? [] : [[line, b[index]] as [string, string]]
  )
}

describe('reading', () => {
  test('values compare without quotes, case, or the spelling of true', () => {
    assert.equal(normalizeSetting('"VMU A1"'), 'vmu a1')
    assert.equal(normalizeSetting(' True '), 'true')
    assert.equal(normalizeSetting('1'), 'true')
    assert.equal(normalizeSetting('0'), 'false')
    assert.equal(normalizeSetting(null), null)
  })

  test('a RetroArch value is read unquoted', () => {
    assert.equal(cfgValue(CORE_OPTIONS, 'reicast_per_content_vmus'), 'disabled')
    assert.equal(cfgValue(CORE_OPTIONS, 'no_such_key'), null)
  })

  test('the system-wide label of a gamelist, before or inside the list', () => {
    const before =
      '<?xml version="1.0"?>\n<alternativeEmulator>\n\t<label>SwanStation</label>\n</alternativeEmulator>\n<gameList>\n</gameList>\n'
    const inside =
      '<gameList>\n\t<alternativeEmulator>\n\t\t<label>Beetle PSX HW</label>\n\t</alternativeEmulator>\n</gameList>\n'
    assert.equal(gamelistSystemLabel(before), 'SwanStation')
    assert.equal(gamelistSystemLabel(inside), 'Beetle PSX HW')
    assert.equal(gamelistSystemLabel('<gameList></gameList>'), null)
  })

  test('each game that overrides the system names its own label', () => {
    const list =
      '<gameList><game><path>./a.chd</path><altemulator>Beetle PSX HW</altemulator></game>' +
      '<game><path>./b.chd</path></game><game><altemulator>A &amp; B</altemulator></game></gameList>'
    assert.deepEqual(gamelistGameLabels(list), ['Beetle PSX HW', 'A & B'])
  })
})

describe('the rules, against RetroDECK as it ships', () => {
  test('PCSX2 already manages its folder cards per game', () => {
    assert.equal(
      evaluateSaveSetupRule(rule('pcsx2.folderAutoManage'), PCSX2_INI, context()).status,
      'ok'
    )
  })

  test('Flycast ships with per-game VMUs off, which RomMix can set', () => {
    const found = evaluateSaveSetupRule(rule('flycast.perContentVmu'), CORE_OPTIONS, context())
    assert.deepEqual(found, { found: 'disabled', status: 'drift' })
  })

  test('Dolphin with a raw card in slot A drifts; a moved GCI folder is for a person to undo', () => {
    const ini = '[Core]\nSlotA = 1\nGCIFolderAPath = /mnt/cards\n'
    assert.equal(evaluateSaveSetupRule(rule('dolphin.gciFolder'), ini, context()).status, 'drift')
    assert.equal(
      evaluateSaveSetupRule(rule('dolphin.gciFolderPath'), ini, context()).status,
      'report-only'
    )
    assert.equal(
      evaluateSaveSetupRule(rule('dolphin.gciFolderPath'), '[Core]\nSlotA = 8\n', context()).status,
      'ok'
    )
  })

  test('a file that is not there is said to be missing, unless its absence is the answer', () => {
    assert.equal(
      evaluateSaveSetupRule(rule('dolphin.gciFolder'), null, context()).status,
      'missing-file'
    )
    assert.equal(
      evaluateSaveSetupRule(rule('flycast.perContentVmuOverride'), null, context()).status,
      'ok'
    )
  })

  test('RetroArch left at its own defaults is laid out as RomMix reads it, but for sorting by content', () => {
    assert.equal(evaluateSaveSetupRule(rule('retroarch.sortByCore'), '', context()).status, 'ok')
    assert.equal(evaluateSaveSetupRule(rule('retroarch.inContentDir'), '', context()).status, 'ok')
    assert.equal(
      evaluateSaveSetupRule(rule('retroarch.sortByContent'), '', context()).status,
      'drift'
    )
  })

  test('the card in slot 1 is a folder card only where PCSX2’s superblock is in it', () => {
    const ini = '[MemoryCards]\nSlot1_Filename = Mcd001.ps2\n'
    const card = `${RD}/saves/ps2/pcsx2/memcards/Mcd001.ps2`
    assert.deepEqual(
      evaluateSaveSetupRule(
        rule('pcsx2.cardIsFolder'),
        ini,
        context({ [`${card}/_pcsx2_superblock`]: 'x' })
      ),
      { found: 'folder card', status: 'ok' }
    )
    assert.deepEqual(
      evaluateSaveSetupRule(rule('pcsx2.cardIsFolder'), ini, context({ [card]: 'raw image' })),
      { found: 'Mcd001.ps2', status: 'report-only' }
    )
  })

  test('with no gamelist, the system runs the first command ES-DE lists', () => {
    const install = '/var/rd'
    const esSystems =
      '<systemList><system><name>psx</name><command label="Beetle PSX">x</command>' +
      '<command label="SwanStation">y</command></system></systemList>'
    const ctx = context(
      {
        [`${install}/files/retrodeck/components/es-de/share/es-de/resources/systems/linux/es_systems.xml`]:
          esSystems
      },
      install
    )
    assert.deepEqual(evaluateSaveSetupRule(rule('esde.component.psx'), null, ctx), {
      found: 'Beetle PSX',
      status: 'drift'
    })
    assert.equal(
      evaluateSaveSetupRule(rule('esde.component.psx'), null, context()).status,
      'missing-file'
    )
  })

  test('a game set to another emulator is reported by label, never changed', () => {
    const list =
      '<alternativeEmulator><label>SwanStation</label></alternativeEmulator><gameList>' +
      '<game><altemulator>Beetle PSX HW</altemulator></game>' +
      '<game><altemulator>SwanStation</altemulator></game></gameList>'
    assert.deepEqual(evaluateSaveSetupRule(rule('esde.games.psx'), list, context()), {
      found: 'Beetle PSX HW',
      status: 'report-only'
    })
    assert.equal(applySaveSetupRule(rule('esde.games.psx'), list), null)
    assert.equal(evaluateSaveSetupRule(rule('esde.component.psx'), list, context()).status, 'ok')
  })

  test('every label is the command RetroDECK itself runs first, psx on SwanStation', () => {
    // The system list RetroDECK 0.10.9b bundles, cut to the systems here.
    const xml = readFileSync(new URL('es_systems.xml', FIXTURES), 'utf8')
    const first = (system: string): string | null => {
      for (const [, block] of xml.matchAll(/<system>([\s\S]*?)<\/system>/g)) {
        if (/<name>\s*([\s\S]*?)\s*<\/name>/.exec(block)?.[1] !== system) continue
        return /<command\s+label="([^"]*)"/.exec(block)?.[1] ?? null
      }
      return null
    }
    for (const [system, label] of Object.entries(RETRODECK_SYSTEM_LABELS)) {
      assert.equal(label, first(system), system)
    }
    assert.equal(RETRODECK_SYSTEM_LABELS.psx, 'SwanStation')
    // Mesen is RetroDECK's choice for nes and saves the same `.srm`: not a row.
    assert.equal(first('nes'), 'Mesen')
    assert.equal(RETRODECK_SYSTEM_LABELS.nes, undefined)
  })

  test('a DuckStation card type is reported, never changed', () => {
    const ini = '[MemoryCards]\nCard1Type = Shared\n'
    assert.equal(
      evaluateSaveSetupRule(rule('duckstation.perGameCard'), ini, context()).status,
      'report-only'
    )
    assert.equal(applySaveSetupRule(rule('duckstation.perGameCard'), ini), null)
  })

  test('every rule explains itself in words', () => {
    for (const one of SAVE_SETUP_RULES) {
      assert.notEqual(localize(one.reason, ENGLISH), '', one.id)
      assert.doesNotMatch(localize(one.reason, ENGLISH), /\{/, one.id)
    }
  })

  test('a per-game Flycast override on this machine is a rule of its own, report-only', () => {
    const findings = evaluateSaveSetup(
      context({
        [`${CONFIG}/retroarch/config/Flycast/Crazy Taxi.opt`]:
          'reicast_per_content_vmus = "disabled"\n',
        [`${CONFIG}/retroarch/config/Flycast/Flycast.opt`]: 'reicast_per_content_vmus = "VMU A1"\n'
      })
    )
    const perGame = findings.find((one) => one.rule.id === 'flycast.perGame.Crazy Taxi')
    assert.equal(perGame?.status, 'report-only')
    assert.equal(
      findings.find((one) => one.rule.id === 'flycast.perContentVmuOverride')?.status,
      'ok'
    )
  })
})

describe('which Flycast options file is checked', () => {
  const OVERRIDE = `${CONFIG}/retroarch/config/Flycast/Flycast.opt`
  const GLOBAL = `${CONFIG}/retroarch/retroarch-core-options.cfg`
  const cfg = (global: string): Record<string, string> => ({
    [`${CONFIG}/retroarch/retroarch.cfg`]: `global_core_options = "${global}"\n`
  })
  const core = (files: Record<string, string>) =>
    evaluateSaveSetup(context(files)).find((one) => one.rule.id === 'flycast.perContentVmuOverride')

  test('with options per core, Flycast.opt, whose absence leaves the global file in charge', () => {
    for (const files of [cfg('false'), {}]) {
      const absent = core({ ...files, [GLOBAL]: CORE_OPTIONS })
      assert.equal(absent?.file, OVERRIDE)
      assert.equal(absent?.status, 'ok')
      const off = core({ ...files, [OVERRIDE]: 'reicast_per_content_vmus = "disabled"\n' })
      assert.deepEqual([off?.file, off?.status], [OVERRIDE, 'drift'])
    }
  })

  test('with global options, the global file, and Flycast.opt is not looked at', () => {
    const found = core({
      ...cfg('true'),
      [GLOBAL]: CORE_OPTIONS,
      [OVERRIDE]: 'reicast_per_content_vmus = "VMU A1"\n'
    })
    assert.equal(found?.file, GLOBAL)
    assert.deepEqual([found?.found, found?.status], ['disabled', 'drift'])
    assert.equal(core({ ...cfg('true') })?.status, 'missing-file')
    const fixed = core({
      ...cfg('true'),
      [GLOBAL]: setCfgValue(CORE_OPTIONS, 'reicast_per_content_vmus', 'VMU A1')
    })
    assert.equal(fixed?.status, 'ok')
  })
})

describe('editing', () => {
  test('a RetroArch value is changed on its own line and nowhere else', () => {
    const after = setCfgValue(CORE_OPTIONS, 'reicast_per_content_vmus', 'VMU A1')
    assert.deepEqual(changedLines(CORE_OPTIONS, after), [
      ['reicast_per_content_vmus = "disabled"', 'reicast_per_content_vmus = "VMU A1"']
    ])
    assert.equal(
      evaluateSaveSetupRule(rule('flycast.perContentVmu'), after, context()).status,
      'ok'
    )
  })

  test('a fix applied twice is the same file as a fix applied once', () => {
    const once = applySaveSetupRule(rule('flycast.perContentVmu'), CORE_OPTIONS) ?? ''
    assert.equal(applySaveSetupRule(rule('flycast.perContentVmu'), once), once)
    const ini = applySaveSetupRule(rule('dolphin.gciFolder'), '[Core]\nSlotA = 1\n') ?? ''
    assert.equal(applySaveSetupRule(rule('dolphin.gciFolder'), ini), ini)
  })

  test('an INI value keeps the spacing around its =, and the rest of the file', () => {
    const before = PCSX2_INI.replace('McdFolderAutoManage = true', 'McdFolderAutoManage=false')
    const after = setIniValue(before, 'EmuCore', 'McdFolderAutoManage', 'true')
    assert.deepEqual(changedLines(before, after), [
      ['McdFolderAutoManage=false', 'McdFolderAutoManage=true']
    ])
  })

  test('a key the section lacks goes at the end of that section, before its blank line', () => {
    const before = '[Core]\nSlotB = 255\n\n[Display]\nFullscreen = True\n'
    assert.equal(
      setIniValue(before, 'Core', 'SlotA', '8'),
      '[Core]\nSlotB = 255\nSlotA = 8\n\n[Display]\nFullscreen = True\n'
    )
  })

  test('a section the file lacks goes at the end', () => {
    assert.equal(
      setIniValue('[General]\nA = 1\n', 'MemoryCards', 'Card1Type', 'PerGameTitle'),
      '[General]\nA = 1\n\n[MemoryCards]\nCard1Type = PerGameTitle\n'
    )
    assert.equal(setIniValue('', 'Core', 'SlotA', '8'), '[Core]\nSlotA = 8\n')
  })

  test('a file written with CRLF stays CRLF', () => {
    const before = '[Core]\r\nSlotA = 1\r\nSlotB = 255\r\n'
    assert.equal(
      setIniValue(before, 'Core', 'SlotA', '8'),
      '[Core]\r\nSlotA = 8\r\nSlotB = 255\r\n'
    )
  })

  test('a commented-out key is not the key', () => {
    assert.equal(
      setIniValue('[Core]\n; SlotA = 1\n', 'Core', 'SlotA', '8'),
      '[Core]\n; SlotA = 1\nSlotA = 8\n'
    )
  })

  test('the gamelist label is edited where ES-DE wrote it, before the list or inside it', () => {
    const before =
      '<?xml version="1.0"?>\n<alternativeEmulator>\n\t<label>Beetle PSX HW</label>\n</alternativeEmulator>\n<gameList>\n\t<game><path>./a.chd</path></game>\n</gameList>\n'
    assert.equal(
      setGamelistSystemLabel(before, 'SwanStation'),
      before.replace('Beetle PSX HW', 'SwanStation')
    )
    const inside =
      '<gameList>\n\t<alternativeEmulator>\n\t\t<label>Beetle PSX HW</label>\n\t</alternativeEmulator>\n</gameList>\n'
    assert.equal(
      setGamelistSystemLabel(inside, 'SwanStation'),
      inside.replace('Beetle PSX HW', 'SwanStation')
    )
  })

  test('a gamelist without the element gets it before the list, and a missing one is created', () => {
    const before =
      '<?xml version="1.0"?>\n<gameList>\n\t<game><path>./a.chd</path></game>\n</gameList>\n'
    const after = setGamelistSystemLabel(before, 'SwanStation')
    assert.equal(
      after,
      '<?xml version="1.0"?>\n<alternativeEmulator>\n\t<label>SwanStation</label>\n</alternativeEmulator>\n<gameList>\n\t<game><path>./a.chd</path></game>\n</gameList>\n'
    )
    assert.equal(gamelistSystemLabel(setGamelistSystemLabel(null, 'A & B')), 'A & B')
    assert.equal(setGamelistSystemLabel(after, 'SwanStation'), after)
  })

  test('a report-only rule has no edit to make', () => {
    assert.equal(applySaveSetupRule(rule('pcsx2.cardIsFolder'), PCSX2_INI), null)
    assert.equal(applySaveSetupRule(rule('dolphin.gciFolderPath'), '[Core]\n'), null)
  })
})
