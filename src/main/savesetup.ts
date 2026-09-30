import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { applySaveSetupRule, evaluateSaveSetup, saveSetupTarget } from '@config/emulators'
import type {
  EmulatorState,
  SaveEnvironment,
  SaveSetupFinding,
  SaveSetupTarget
} from '@config/emulators'
import { localize } from '@shared/i18n'
import type { SaveSetupItem, SaveSetupReport } from '@shared/types'
import { i18n, t } from './i18n.ts'
import { log } from './log.ts'
import { fileSystemEnvironment } from './saveenv.ts'
import { backupPath, keepBackup } from './savefiles.ts'

/**
 * The save-relevant emulator settings, on this machine: checked, written down
 * for bazzite-maint, and fixed one at a time when somebody confirms it.
 *
 * The rules are the descriptor's — `retrodeck/savesetup.ts` — and nothing here
 * names an emulator. What is here is everything that touches the disk, and the
 * guards around the one thing that writes to another program's files:
 *
 *  - never while a game is playing or the emulator's install is running, which
 *    would write its config back on exit and undo the edit;
 *  - never through a link, which could be pointing anywhere;
 *  - never creating an emulator's config file that is not there — that is the
 *    emulator's to write the first time it runs;
 *  - always after a copy of the file is kept, in RomMix's own folder;
 *  - and only when the value is actually off, so a second fix is a no-op that
 *    writes and copies nothing.
 */

/** What the check needs from the rest of RomMix, so a test can hand it a machine. */
export interface SaveSetupDeps {
  /** The emulator probe, as it stands. */
  emulators: () => Promise<EmulatorState[]>
  /** Whether a game RomMix launched is running. */
  playing: () => boolean
  /** The processes whose command line carries `marker`, as descriptions. */
  running: (marker: string) => Promise<string[]>
  /** RomMix's own config folder: the report goes here, the copies below it. */
  configDir: string
  /** Asked when a report is written, Electron not answering before it is ready. */
  version: () => string
  env?: SaveEnvironment
  now?: () => Date
}

/** The file bazzite-maint reads, in RomMix's config folder. */
export const SAVE_SETUP_FILE = 'save-setup.json'

export class SaveSetup {
  private readonly env: SaveEnvironment

  constructor(private readonly deps: SaveSetupDeps) {
    this.env = deps.env ?? fileSystemEnvironment()
  }

  get reportPath(): string {
    return join(this.deps.configDir, SAVE_SETUP_FILE)
  }

  private async target(): Promise<SaveSetupTarget | null> {
    return saveSetupTarget(await this.deps.emulators(), this.env)
  }

  /**
   * Read every rule, write the report, and hand it back — or null where no
   * install is checked, in which case an old report is left where it is rather
   * than claiming a machine it no longer describes is fine.
   */
  async check(): Promise<SaveSetupReport | null> {
    const target = await this.target()
    if (!target) return null
    return this.report(target)
  }

  private async report(target: SaveSetupTarget): Promise<SaveSetupReport> {
    const report: SaveSetupReport = {
      schema: 1,
      rommix: this.deps.version(),
      checkedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      emulator: target.emulator,
      items: evaluateSaveSetup(target.ctx).map((finding) => this.item(finding))
    }
    await writeJsonAtomic(this.reportPath, report)
    const off = report.items.filter((item) => item.status !== 'ok')
    log.info('savesetup', 'checked the save-relevant emulator settings', {
      emulator: report.emulator,
      items: report.items.length,
      off: off.map((item) => ({ id: item.id, status: item.status, found: item.found }))
    })
    return report
  }

  private item(finding: SaveSetupFinding): SaveSetupItem {
    const { rule } = finding
    // The pure reading cannot tell a file that is not there from one it may not
    // read; the disk can, and the two want different things done about them.
    const status =
      finding.status === 'missing-file' && this.env.exists(finding.file)
        ? 'unreadable'
        : finding.status
    return {
      id: rule.id,
      file: finding.file,
      format: rule.format,
      section: rule.section,
      key: rule.key,
      wanted: rule.wanted,
      found: finding.found,
      status,
      fix: rule.fix,
      reason: localize(rule.reason, i18n()),
      check: rule.check ?? 'value',
      absentIsFine: rule.absentIsFine === true,
      // Only a plain value goes through `normalizeSetting`; a label is ES-DE's
      // own string and a folder card is RomMix's reading of the disk.
      compare: rule.check ? 'exact' : 'normalized'
    }
  }

  /** Refuse while anything that would write the config back is running. */
  private async ensureIdle(target: SaveSetupTarget): Promise<void> {
    const running = this.deps.playing() ? ['a game RomMix started'] : []
    running.push(...(await this.deps.running(target.busyMarker)))
    if (running.length > 0) {
      log.warn('savesetup', 'refused a fix while the emulator is running', { running })
      throw new Error(t('diagnostics.saveSetupBusy'))
    }
  }

  /**
   * Set one rule's value, after the person in front of RomMix confirmed it.
   *
   * Returns the report as it stands afterwards. A rule already as wanted is
   * left alone — no copy, no write — so pressing the button twice is harmless.
   */
  async fix(id: string): Promise<SaveSetupReport> {
    const target = await this.target()
    if (!target) throw new Error(t('diagnostics.saveSetupNotFixable'))
    await this.ensureIdle(target)

    const finding = evaluateSaveSetup(target.ctx).find((one) => one.rule.id === id)
    if (!finding || finding.rule.fix !== 'edit') {
      throw new Error(t('diagnostics.saveSetupNotFixable'))
    }
    if (finding.status === 'ok') {
      log.info('savesetup', 'nothing to fix, the setting is already as wanted', { id })
      return this.report(target)
    }

    const { rule, file } = finding
    const info = await lstat(file).catch(() => null)
    if (info?.isSymbolicLink()) {
      log.warn('savesetup', 'refused to edit a setting through a link', { id, file })
      throw new Error(t('diagnostics.saveSetupLink', { file }))
    }
    // A gamelist is ES-DE's list of what it has scraped, and none is the
    // ordinary state of a system with no games yet; an emulator's config file
    // that is not there is one the emulator has not written yet.
    if (!info && rule.format !== 'esde-gamelist') {
      throw new Error(t('diagnostics.saveSetupNoFile', { file }))
    }

    const before = info ? await readFile(file, 'utf8') : null
    const after = applySaveSetupRule(rule, before)
    if (after === null) throw new Error(t('diagnostics.saveSetupNotFixable'))
    if (after === before) return this.report(target)

    // Asked again at the last moment: the check above was before the reads.
    await this.ensureIdle(target)

    let copy: string | null = null
    if (info) {
      const backups = join(
        this.deps.configDir,
        'emulator-backups',
        rule.component,
        dirname(rule.file)
      )
      try {
        await keepBackup(file, backups)
      } catch (cause) {
        log.warn('savesetup', 'could not keep a copy of a config file', {
          file,
          reason: (cause as Error).message
        })
      }
      copy = backupPath(backups, file, 1)
      if (!(await stat(copy).catch(() => null))) {
        throw new Error(t('diagnostics.saveSetupNoBackup', { file }))
      }
    }

    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.rommix.tmp`
    try {
      await writeFile(tmp, after, 'utf8')
      if (info) await chmod(tmp, info.mode & 0o7777)
      await rename(tmp, file)
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
    }

    log.info('savesetup', 'changed a save-relevant setting', {
      id,
      file,
      key: rule.key,
      before: finding.found,
      after: rule.wanted,
      copy
    })
    return this.report(target)
  }
}

/** Write JSON beside its destination and rename it over, so a reader never sees half. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Named per write: the start-up check and a pre-flight check can overlap,
  // and two writers sharing one temporary name can rename half of the other's.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}
