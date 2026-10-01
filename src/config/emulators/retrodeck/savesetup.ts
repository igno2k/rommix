import type { Text } from '@shared/i18n'
import { iniValue } from '../ini.ts'
import { joinPath } from '../savepaths.ts'
import type { SaveEnvironment } from '../savepaths.ts'
import type { EmulatorState } from '../types.ts'
import type { BusyWhile } from '../savepaths.ts'
import { pcsx2Card, pcsx2Memcards, pcsx2Slot1, PCSX2_BUSY, PCSX2_INI } from './saves.ts'

/**
 * The two PCSX2 settings per-game PS2 save sync depends on, as RetroDECK
 * installs them: the card in slot 1 is a folder card, and PCSX2 manages it per
 * game. Pure — the reading and the one edit are functions of text — so
 * `src/main/savesetup.ts` is left with the disk, the copy and the guards.
 */

export type SaveSetupId = 'pcsx2.folderAutoManage' | 'pcsx2.cardIsFolder'

/** One setting as it stands on this machine. */
export interface SaveSetupFinding {
  id: SaveSetupId
  /** Absolute path of `PCSX2.ini`. */
  file: string
  section: string
  key: string
  /** The value there now, or null where the key or the file is absent. */
  found: string | null
  status: 'ok' | 'off'
  /**
   * The value RomMix sets `key` to, once somebody confirms. Absent where it is
   * a person's to change.
   */
  wanted?: string
  reason: Text
}

/** RetroDECK, where it is installed: where its files are, and how to tell it runs. */
export interface SaveSetupTarget {
  configDir: string
  saves: string | null
  /** A fix is refused while this runs: PCSX2 writes its settings back on exit. */
  busy: BusyWhile
  env: SaveEnvironment
}

/** RetroDECK where it is installed and has a config root, or null. */
export function saveSetupTarget(
  states: readonly EmulatorState[],
  env: SaveEnvironment
): SaveSetupTarget | null {
  const state = states.find((one) => one.id === 'retrodeck' && one.available)
  if (!state?.configDir) return null
  return { configDir: state.configDir, saves: state.paths.saves, busy: PCSX2_BUSY, env }
}

/**
 * How PCSX2 reads a boolean (`StringUtil::FromChars<bool>`, `common/StringUtil.h`,
 * v2.6.3, :180-196): case aside, any start of these words, `true` first. Neither
 * leaves the default in place.
 */
const TRUE_WORDS = ['true', 'yes', 'on', '1', 'enabled']
const FALSE_WORDS = ['false', 'no', 'off', '0', 'disabled']

function readsFalse(value: string): boolean {
  const v = value.trim().toLowerCase()
  const starts = (word: string): boolean => word.startsWith(v)
  return !TRUE_WORDS.some(starts) && FALSE_WORDS.some(starts)
}

/** Both settings, read from `PCSX2.ini` and the card folder. */
export function checkSaveSetup(target: SaveSetupTarget): SaveSetupFinding[] {
  const file = joinPath(target.configDir, PCSX2_INI)
  // Read as PCSX2 reads it: a file or key that is not there is PCSX2's own
  // default, which is on (`Pcsx2Config::Pcsx2Config`, `pcsx2/Pcsx2Config.cpp`
  // :1922).
  const text = target.env.text(file)
  const manage = iniValue(text, 'EmuCore', 'McdFolderAutoManage')
  const autoManage: SaveSetupFinding = {
    id: 'pcsx2.folderAutoManage',
    file,
    section: 'EmuCore',
    key: 'McdFolderAutoManage',
    found: manage,
    status: manage !== null && readsFalse(manage) ? 'off' : 'ok',
    wanted: 'true',
    reason: 'saveSetup.pcsx2FolderAutoManage'
  }

  // Reported, never changed: converting a card moves every game's saves at
  // once, which is PCSX2's own memory-card settings' job and a person's call
  // (Convert, `MemoryCardSettingsWidget::convertCard`, pcsx2-qt v2.6.3
  // :266-283). Argosy asks the same of its users: "create a folder-type card
  // in the emulator's card manager and assign it to Slot 1"
  // (https://github.com/rommapp/argosy-launcher/wiki/Save-Sync).
  const memcards = pcsx2Memcards(
    target.configDir,
    target.saves ? joinPath(target.saves, 'ps2', 'pcsx2', 'memcards') : null,
    target.env
  )
  const slot1 = memcards ? pcsx2Slot1(target.configDir, memcards, target.env) : null
  const card = memcards ? pcsx2Card(target.configDir, memcards, target.env) : null
  const named = iniValue(text, 'MemoryCards', 'Slot1_Filename')
  const cardIsFolder: SaveSetupFinding = {
    id: 'pcsx2.cardIsFolder',
    file,
    section: 'MemoryCards',
    key: 'Slot1_Filename',
    found: named,
    // Where the card folder is unknown there is no card to judge.
    status: !memcards || card ? 'ok' : 'off',
    // No card at all is not one to convert: a folder card has to be created.
    // Left alone, PCSX2 makes a missing card an 8 MB file card the first time a
    // game starts (`pcsx2/SIO/Memcard/MemoryCardFile.cpp`, v2.6.3, :595 and
    // `FileMemoryCard::Open` :287-295), which is a card to convert.
    reason:
      slot1 && !target.env.exists(slot1) ? 'saveSetup.pcsx2NoCard' : 'saveSetup.pcsx2CardIsFolder'
  }
  return [autoManage, cardIsFolder]
}

/**
 * `text` with `key` under `[section]` set to `value`, and every other byte as
 * it was.
 *
 * The value on an existing line is replaced in place, keeping the spacing
 * around the `=`. A key the section lacks goes in after the section's last
 * line; a section the file lacks goes at the end. Line endings follow the
 * file's own.
 */
export function setIniValue(text: string, section: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  let start = -1
  let end = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(lines[index])
    if (!header) continue
    if (start !== -1) {
      end = index
      break
    }
    if (header[1].trim().toLowerCase() === section.toLowerCase()) start = index
  }

  if (start === -1) {
    const lead = text === '' ? '' : text.endsWith('\n') ? eol : `${eol}${eol}`
    return `${text}${lead}[${section}]${eol}${key} = ${value}${eol}`
  }
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]
    const cut = line.indexOf('=')
    if (cut === -1 || /^\s*[;#]/.test(line)) continue
    if (line.slice(0, cut).trim().toLowerCase() !== key.toLowerCase()) continue
    lines[index] = `${/^[^=]*=\s*/.exec(line)?.[0] ?? ''}${value}`
    return lines.join(eol)
  }
  // After the section's last non-empty line, so a blank line separating it
  // from the next section stays where it was.
  let at = end
  while (at > start + 1 && lines[at - 1].trim() === '') at -= 1
  lines.splice(at, 0, `${key} = ${value}`)
  return lines.join(eol)
}
