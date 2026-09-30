import type { Text } from '@shared/i18n'
import { iniValue } from '../ini.ts'
import { joinPath } from '../savepaths.ts'
import type { SaveEnvironment } from '../savepaths.ts'
import { PS2_SUPERBLOCK } from '../units/ps2.ts'
import { retroDeckSystemLabel } from './saves.ts'

/**
 * The emulator settings that decide where, and in what shape, RetroDECK's
 * emulators write a save — the ones per-game save sync depends on.
 *
 * RomMix is the one writer of these. It checks them, says what is off and why,
 * and changes one only when the person in front of it confirms; bazzite-maint
 * reads the report RomMix writes (`save-setup.json`) and checks the same keys
 * without a rule table of its own. Render settings are not here: they decide
 * nothing about a save.
 *
 * Everything in this file is pure — rules as data, and the reads and edits as
 * functions of text — so the adapter in `src/main/savesetup.ts` is left with
 * the disk, the backups and the guards.
 */

export type SaveSetupFormat = 'ini' | 'cfg' | 'esde-gamelist'

/**
 * `ok` as wanted; `drift` off, and RomMix can set it; `report-only` off, and a
 * person has to; `missing-file` the file is not there; `unreadable` the file is
 * there and could not be read.
 */
export type SaveSetupStatus = 'ok' | 'drift' | 'missing-file' | 'report-only' | 'unreadable'

export interface SaveSetupRule {
  id: string
  /** Which emulator the file is — also the folder its backups are kept in. */
  component: string
  /** Which root `file` is under: the flatpak's config, or RetroDECK's own home. */
  root: 'config' | 'home'
  file: string
  format: SaveSetupFormat
  section: string | null
  key: string
  wanted: string
  /** A key the file does not mention is as good as `wanted`. */
  absentIsFine?: boolean
  fix: 'edit' | 'report-only'
  reason: Text
  /**
   * What is compared, where it is not the value itself: `folder-card` asks
   * whether the card the key names is a PCSX2 folder card, `system-label` which
   * command ES-DE runs the system with, `game-labels` which games override it.
   */
  check?: 'folder-card' | 'system-label' | 'game-labels'
}

/** One rule as it stands on this machine. */
export interface SaveSetupFinding {
  rule: SaveSetupRule
  /** Absolute path of the file. */
  file: string
  found: string | null
  status: SaveSetupStatus
}

/** Where the files are, and a read-only view of them. */
export interface SaveSetupContext {
  /** The flatpak's config root, `~/.var/app/net.retrodeck.retrodeck/config`. */
  configDir: string | null
  /** RetroDECK's own home, `~/retrodeck`, where ES-DE keeps its gamelists. */
  home: string | null
  /** RetroDECK's saves root. */
  saves: string | null
  /** Where RetroDECK's own files were deployed, for ES-DE's system list. */
  installDir: string | null
  env: SaveEnvironment
}

/**
 * The command every system that matters runs with, by ES-DE's own label.
 *
 * The owner's choice, and the one bazzite-maint tunes for: one core per system,
 * so a save written on one device is read by the same program on the other.
 * Labels are ES-DE's exact strings — a label ES-DE does not list is ignored by
 * it — checked against the `es_systems.xml` ES-DE ships.
 */
export const RETRODECK_SYSTEM_LABELS: Readonly<Record<string, string>> = {
  psx: 'SwanStation',
  gba: 'mGBA',
  nes: 'Nestopia UE',
  snes: 'Snes9x - Current',
  n64: 'Mupen64Plus-Next',
  megadrive: 'Genesis Plus GX',
  genesis: 'Genesis Plus GX',
  segacd: 'Genesis Plus GX',
  nds: 'DeSmuME',
  dreamcast: 'Flycast',
  ps2: 'PCSX2 (Standalone)',
  psp: 'PPSSPP (Standalone)',
  gc: 'Dolphin (Standalone)',
  wii: 'Dolphin (Standalone)'
}

const RETROARCH_CFG = 'retroarch/retroarch.cfg'
const CORE_OPTIONS = 'retroarch/retroarch-core-options.cfg'
/** Where RetroArch keeps Flycast's overrides: a folder named after the core. */
const FLYCAST_OVERRIDES = 'retroarch/config/Flycast'
const VMU_KEY = 'reicast_per_content_vmus'
const VMU_WANTED = 'VMU A1'

/** The rules that do not depend on what is on this machine. */
export const SAVE_SETUP_RULES: readonly SaveSetupRule[] = [
  {
    id: 'pcsx2.folderAutoManage',
    component: 'pcsx2',
    root: 'config',
    file: 'PCSX2/inis/PCSX2.ini',
    format: 'ini',
    section: 'EmuCore',
    key: 'McdFolderAutoManage',
    wanted: 'true',
    // PCSX2's own default.
    absentIsFine: true,
    fix: 'edit',
    reason: 'saveSetup.pcsx2FolderAutoManage'
  },
  {
    id: 'pcsx2.cardIsFolder',
    component: 'pcsx2',
    root: 'config',
    file: 'PCSX2/inis/PCSX2.ini',
    format: 'ini',
    section: 'MemoryCards',
    key: 'Slot1_Filename',
    wanted: 'folder card',
    fix: 'report-only',
    reason: 'saveSetup.pcsx2CardIsFolder',
    check: 'folder-card'
  },
  {
    id: 'dolphin.gciFolder',
    component: 'dolphin',
    root: 'config',
    file: 'dolphin-emu/Dolphin.ini',
    format: 'ini',
    section: 'Core',
    key: 'SlotA',
    wanted: '8',
    fix: 'edit',
    reason: 'saveSetup.dolphinGciFolder'
  },
  {
    id: 'dolphin.gciFolderPath',
    component: 'dolphin',
    root: 'config',
    file: 'dolphin-emu/Dolphin.ini',
    format: 'ini',
    section: 'Core',
    key: 'GCIFolderAPath',
    wanted: '',
    absentIsFine: true,
    fix: 'report-only',
    reason: 'saveSetup.dolphinGciFolderPath'
  },
  {
    id: 'flycast.perContentVmu',
    component: 'retroarch',
    root: 'config',
    file: CORE_OPTIONS,
    format: 'cfg',
    section: null,
    key: VMU_KEY,
    wanted: VMU_WANTED,
    fix: 'edit',
    reason: 'saveSetup.flycastPerContentVmu'
  },
  {
    id: 'flycast.perContentVmuOverride',
    component: 'retroarch',
    root: 'config',
    file: `${FLYCAST_OVERRIDES}/Flycast.opt`,
    format: 'cfg',
    section: null,
    key: VMU_KEY,
    wanted: VMU_WANTED,
    absentIsFine: true,
    fix: 'edit',
    reason: 'saveSetup.flycastOverride'
  },
  // RetroArch's own defaults are the two `false`s, so a config that leaves
  // them out is laid out the way RomMix reads it.
  ...(
    [
      ['retroarch.sortByContent', 'sort_savefiles_by_content_enable', 'true', false],
      ['retroarch.inContentDir', 'savefiles_in_content_dir', 'false', true],
      ['retroarch.sortByCore', 'sort_savefiles_enable', 'false', true]
    ] as const
  ).map(([id, key, wanted, absentIsFine]): SaveSetupRule => ({
    id,
    component: 'retroarch',
    root: 'config',
    file: RETROARCH_CFG,
    format: 'cfg',
    section: null,
    key,
    wanted,
    absentIsFine,
    fix: 'edit',
    reason: 'saveSetup.retroarchLayout'
  })),
  {
    id: 'duckstation.perGameCard',
    component: 'duckstation',
    root: 'config',
    file: 'duckstation/settings.ini',
    format: 'ini',
    section: 'MemoryCards',
    key: 'Card1Type',
    wanted: 'PerGameTitle',
    fix: 'edit',
    reason: 'saveSetup.duckstationPerGameCard'
  },
  ...Object.entries(RETRODECK_SYSTEM_LABELS).flatMap(([system, label]): SaveSetupRule[] => [
    {
      id: `esde.component.${system}`,
      component: 'es-de',
      root: 'home',
      file: `ES-DE/gamelists/${system}/gamelist.xml`,
      format: 'esde-gamelist',
      section: null,
      key: 'alternativeEmulator',
      wanted: label,
      fix: 'edit',
      reason: { key: 'saveSetup.esdeComponent', params: { system, label } },
      check: 'system-label'
    },
    {
      id: `esde.games.${system}`,
      component: 'es-de',
      root: 'home',
      file: `ES-DE/gamelists/${system}/gamelist.xml`,
      format: 'esde-gamelist',
      section: null,
      key: 'altemulator',
      wanted: label,
      absentIsFine: true,
      fix: 'report-only',
      reason: { key: 'saveSetup.esdeGameOverride', params: { system, label } },
      check: 'game-labels'
    }
  ])
]

/**
 * The per-game Flycast overrides on this machine, each a rule of its own.
 *
 * Report-only: a per-game override is somebody's decision about one game, and
 * reversing it silently is not RomMix's to do.
 */
function perGameFlycastRules(ctx: SaveSetupContext): SaveSetupRule[] {
  if (!ctx.configDir) return []
  return ctx.env
    .files(joinPath(ctx.configDir, FLYCAST_OVERRIDES))
    .filter((name) => name.endsWith('.opt') && name !== 'Flycast.opt')
    .sort()
    .map((name) => ({
      id: `flycast.perGame.${name.replace(/\.opt$/, '')}`,
      component: 'retroarch',
      root: 'config',
      file: `${FLYCAST_OVERRIDES}/${name}`,
      format: 'cfg',
      section: null,
      key: VMU_KEY,
      wanted: VMU_WANTED,
      absentIsFine: true,
      fix: 'report-only',
      reason: 'saveSetup.flycastOverride'
    }))
}

/** Every rule, the per-game overrides found on this machine included. */
export function saveSetupRules(ctx: SaveSetupContext): SaveSetupRule[] {
  return [...SAVE_SETUP_RULES, ...perGameFlycastRules(ctx)]
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A value as the emulators compare it: no quotes, no case, `1` as `true`. */
export function normalizeSetting(value: string | null): string | null {
  if (value === null) return null
  const bare = value
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim()
    .toLowerCase()
  if (bare === '1' || bare === 'yes') return 'true'
  if (bare === '0' || bare === 'no') return 'false'
  return bare
}

/** The value of a `key = "value"` line, as RetroArch writes its config. */
export function cfgValue(text: string | null, key: string): string | null {
  if (text === null) return null
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match && match[1] === key) return match[2].replace(/^"(.*)"$/, '$1')
  }
  return null
}

/** The system-wide `<alternativeEmulator>` label of an ES-DE gamelist. */
export function gamelistSystemLabel(text: string | null): string | null {
  if (text === null) return null
  const block = /<alternativeEmulator>([\s\S]*?)<\/alternativeEmulator>/.exec(text)?.[1]
  const label = block ? /<label>\s*([\s\S]*?)\s*<\/label>/.exec(block)?.[1] : undefined
  return label === undefined ? null : unescapeXml(label)
}

/** Every per-game `<altemulator>` label of an ES-DE gamelist. */
export function gamelistGameLabels(text: string | null): string[] {
  if (text === null) return []
  return [...text.matchAll(/<altemulator>\s*([\s\S]*?)\s*<\/altemulator>/g)].map((match) =>
    unescapeXml(match[1])
  )
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The absolute path of a rule's file, or null where its root is unknown. */
export function saveSetupFile(rule: SaveSetupRule, ctx: SaveSetupContext): string | null {
  const root = rule.root === 'config' ? ctx.configDir : ctx.home
  return root ? joinPath(root, rule.file) : null
}

/** Is `found` what the rule wants? */
function satisfied(rule: SaveSetupRule, found: string | null): boolean {
  if (found === null) return rule.absentIsFine === true
  return normalizeSetting(found) === normalizeSetting(rule.wanted)
}

/**
 * One rule against the file it names — `text` is its contents, null where it
 * is not there.
 */
export function evaluateSaveSetupRule(
  rule: SaveSetupRule,
  text: string | null,
  ctx: SaveSetupContext
): { found: string | null; status: SaveSetupStatus } {
  const off = rule.fix === 'edit' ? 'drift' : 'report-only'

  if (rule.check === 'system-label') {
    // No gamelist is not a missing file here: ES-DE then runs the first
    // command it lists, which is still an answer.
    const found =
      gamelistSystemLabel(text) ??
      retroDeckSystemLabel({
        paths: { home: ctx.home },
        system: rule.id.replace(/^esde\.component\./, ''),
        installDir: ctx.installDir,
        env: ctx.env
      })
    if (found === null) return { found, status: text === null ? 'missing-file' : 'unreadable' }
    return { found, status: found === rule.wanted ? 'ok' : off }
  }
  if (rule.check === 'game-labels') {
    const others = gamelistGameLabels(text).filter((label) => label !== rule.wanted)
    const found = others.length > 0 ? [...new Set(others)].sort().join(', ') : null
    return { found, status: found === null ? 'ok' : off }
  }

  if (text === null) {
    return { found: null, status: rule.absentIsFine ? 'ok' : 'missing-file' }
  }
  const found =
    rule.format === 'ini' ? iniValue(text, rule.section ?? '', rule.key) : cfgValue(text, rule.key)

  if (rule.check === 'folder-card') {
    const name = found ?? 'Mcd001.ps2'
    const card = ctx.saves ? joinPath(ctx.saves, 'ps2', 'pcsx2', 'memcards', name) : null
    const folder = card !== null && ctx.env.exists(joinPath(card, PS2_SUPERBLOCK))
    return { found: folder ? 'folder card' : name, status: folder ? 'ok' : off }
  }
  return { found, status: satisfied(rule, found) ? 'ok' : off }
}

/** Every rule on this machine, read through `ctx.env`. */
export function evaluateSaveSetup(ctx: SaveSetupContext): SaveSetupFinding[] {
  return saveSetupRules(ctx).map((rule) => {
    const file = saveSetupFile(rule, ctx)
    const text = file ? ctx.env.text(file) : null
    return { rule, file: file ?? rule.file, ...evaluateSaveSetupRule(rule, text, ctx) }
  })
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * The file's own line ending, so an edit adds lines the way the rest are
 * written. A Windows-written INI stays one.
 */
function lineEnding(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * `text` with `key` under `[section]` set to `value`, and every other byte as
 * it was.
 *
 * The value on an existing line is replaced in place, keeping the spacing
 * around the `=`. A key the section lacks goes in after the section's last
 * line; a section the file lacks goes at the end.
 */
export function setIniValue(text: string, section: string, key: string, value: string): string {
  const eol = lineEnding(text)
  const lines = text.split(/\r?\n/)
  const wantedSection = section.toLowerCase()
  const wantedKey = key.toLowerCase()
  let start = -1
  let end = lines.length

  for (let index = 0; index < lines.length; index += 1) {
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(lines[index])
    if (!header) continue
    if (start !== -1) {
      end = index
      break
    }
    if (header[1].trim().toLowerCase() === wantedSection) start = index
  }

  if (start === -1) {
    const trailing = text.endsWith('\n') || text === ''
    const lead = text === '' ? '' : trailing ? eol : `${eol}${eol}`
    return `${text}${lead}[${section}]${eol}${key} = ${value}${eol}`
  }

  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]
    const cut = line.indexOf('=')
    if (cut === -1 || /^\s*[;#]/.test(line)) continue
    if (line.slice(0, cut).trim().toLowerCase() !== wantedKey) continue
    const prefix = /^(.*?=\s*)/.exec(line)?.[1] ?? `${key} = `
    lines[index] = `${prefix}${value}`
    return lines.join(eol)
  }

  // After the section's last non-empty line, so a blank line separating it
  // from the next section stays where it was.
  let at = end
  while (at > start + 1 && lines[at - 1].trim() === '') at -= 1
  lines.splice(at, 0, `${key} = ${value}`)
  return lines.join(eol)
}

/** `text` with the RetroArch line `key = "value"` set, and nothing else changed. */
export function setCfgValue(text: string, key: string, value: string): string {
  const eol = lineEnding(text)
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*([A-Za-z0-9_]+)\s*=\s*)/.exec(lines[index])
    if (match && match[2] === key) {
      lines[index] = `${match[1]}"${value}"`
      return lines.join(eol)
    }
  }
  const trailing = text === '' || text.endsWith('\n')
  return `${text}${trailing ? '' : eol}${key} = "${value}"${eol}`
}

/**
 * An ES-DE gamelist with the system-wide emulator set to `label`.
 *
 * ES-DE writes the `<alternativeEmulator>` element before `<gameList>`, and
 * some versions wrote it inside; an existing one is edited where it is, and a
 * new one goes where ES-DE puts it. A missing file becomes the smallest
 * gamelist ES-DE reads: the element and an empty list.
 */
export function setGamelistSystemLabel(text: string | null, label: string): string {
  const escaped = escapeXml(label)
  if (text === null) {
    return (
      '<?xml version="1.0"?>\n<alternativeEmulator>\n\t<label>' +
      escaped +
      '</label>\n</alternativeEmulator>\n<gameList>\n</gameList>\n'
    )
  }
  const block = /<alternativeEmulator>([\s\S]*?)<\/alternativeEmulator>/.exec(text)
  if (block) {
    const inner = block[1]
    const replaced = /<label>[\s\S]*?<\/label>/.test(inner)
      ? inner.replace(/<label>[\s\S]*?<\/label>/, `<label>${escaped}</label>`)
      : `${inner}<label>${escaped}</label>`
    const start = block.index + '<alternativeEmulator>'.length
    return `${text.slice(0, start)}${replaced}${text.slice(start + inner.length)}`
  }
  const eol = lineEnding(text)
  const element = `<alternativeEmulator>${eol}\t<label>${escaped}</label>${eol}</alternativeEmulator>${eol}`
  const list = text.search(/<gameList[\s>/]/)
  if (list !== -1) return `${text.slice(0, list)}${element}${text.slice(list)}`
  return `${text}${text.endsWith('\n') || text === '' ? '' : eol}${element}`
}

/**
 * `text` with `rule` set to what it wants — the edit a confirmed fix writes.
 * Null where the rule is not one RomMix edits.
 */
export function applySaveSetupRule(rule: SaveSetupRule, text: string | null): string | null {
  if (rule.fix !== 'edit') return null
  if (rule.format === 'esde-gamelist') {
    return rule.check === 'system-label' ? setGamelistSystemLabel(text, rule.wanted) : null
  }
  if (rule.format === 'ini')
    return setIniValue(text ?? '', rule.section ?? '', rule.key, rule.wanted)
  return setCfgValue(text ?? '', rule.key, rule.wanted)
}
