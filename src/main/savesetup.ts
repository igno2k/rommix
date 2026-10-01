import { chmod, lstat, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkSaveSetup, saveSetupTarget, setIniValue } from '@config/emulators'
import type { BusyWhile, EmulatorState, SaveEnvironment, SaveSetupTarget } from '@config/emulators'
import { localize } from '@shared/i18n'
import type { SaveSetupItem } from '@shared/types'
import { i18n, t } from './i18n.ts'
import { log } from './log.ts'
import { fileSystemEnvironment } from './saveenv.ts'
import { backupPath, keepBackup } from './savefiles.ts'

/**
 * The emulator settings per-game save sync depends on, on this machine:
 * checked for the pre-flight check, and fixed one at a time when somebody
 * confirms it.
 *
 * The rules are the descriptor's — `retrodeck/savesetup.ts` — and nothing here
 * names an emulator. What is here is everything that touches the disk, and the
 * guards around the one thing that writes to another program's file:
 *
 *  - never while a game is playing or the emulator's install is running, which
 *    would write its config back on exit and undo the edit;
 *  - never through a link, which could be pointing anywhere;
 *  - always after a copy of the file is kept, in RomMix's own folder, and by a
 *    rename over the file, so it is never half written;
 *  - and only when the value is actually off, so a second fix writes nothing.
 */

/** What the check needs from the rest of RomMix, so a test can hand it a machine. */
export interface SaveSetupDeps {
  /** The emulator probe, as it stands. */
  emulators: () => Promise<EmulatorState[]>
  /** Whether a game RomMix launched is running. */
  playing: () => boolean
  /** What of an install is running — see `runningOf`. */
  running: (busy: BusyWhile) => Promise<string[]>
  /** RomMix's own config folder; the copies go below it. */
  configDir: string
  env?: SaveEnvironment
}

export class SaveSetup {
  private readonly env: SaveEnvironment

  constructor(private readonly deps: SaveSetupDeps) {
    this.env = deps.env ?? fileSystemEnvironment()
  }

  private async target(): Promise<SaveSetupTarget | null> {
    return saveSetupTarget(await this.deps.emulators(), this.env)
  }

  /** Every setting as it stands, or null where there is no install to check. */
  async check(): Promise<SaveSetupItem[] | null> {
    const target = await this.target()
    return target ? this.items(target) : null
  }

  private items(target: SaveSetupTarget): SaveSetupItem[] {
    const items = checkSaveSetup(target).map((finding): SaveSetupItem => ({
      id: finding.id,
      file: finding.file,
      key: finding.key,
      found: finding.found,
      status: finding.status,
      wanted: finding.wanted ?? null,
      reason: localize(finding.reason, i18n())
    }))
    log.info('savesetup', 'checked the settings save sync depends on', {
      off: items
        .filter((item) => item.status !== 'ok')
        .map(({ id, status, found }) => ({ id, status, found }))
    })
    return items
  }

  /** Refuse while anything that would write the config back is running. */
  private async ensureIdle(target: SaveSetupTarget): Promise<void> {
    const running = this.deps.playing() ? ['a game RomMix started'] : []
    running.push(...(await this.deps.running(target.busy)))
    if (running.length > 0) {
      log.warn('savesetup', 'refused a fix while the emulator is running', { running })
      throw new Error(t('diagnostics.saveSetupBusy'))
    }
  }

  /**
   * Set one setting, after the person in front of RomMix confirmed it, and
   * return every setting as it stands afterwards. One already as wanted is
   * left alone — no copy, no write — so pressing the button twice is harmless.
   */
  async fix(id: string): Promise<SaveSetupItem[]> {
    const target = await this.target()
    const finding = target ? checkSaveSetup(target).find((one) => one.id === id) : undefined
    if (!target || !finding?.wanted) throw new Error(t('diagnostics.saveSetupNotFixable'))
    await this.ensureIdle(target)
    if (finding.status === 'ok') return this.items(target)

    const { file } = finding
    const info = await lstat(file)
    if (info.isSymbolicLink()) {
      log.warn('savesetup', 'refused to edit a setting through a link', { id, file })
      throw new Error(t('diagnostics.saveSetupLink', { file }))
    }
    const before = await readFile(file, 'utf8')
    const after = setIniValue(before, finding.section, finding.key, finding.wanted)

    // Asked again at the last moment: the check above was before the read.
    await this.ensureIdle(target)

    const backups = join(this.deps.configDir, 'emulator-backups')
    await keepBackup(file, backups)
    const copy = backupPath(backups, file, 1)
    if (!(await stat(copy).catch(() => null))) {
      throw new Error(t('diagnostics.saveSetupNoBackup', { file }))
    }

    const tmp = `${file}.rommix.tmp`
    try {
      await writeFile(tmp, after, 'utf8')
      await chmod(tmp, info.mode & 0o7777)
      await rename(tmp, file)
    } finally {
      await rm(tmp, { force: true }).catch((cause: unknown) =>
        log.warn('savesetup', 'could not remove a temporary copy', {
          tmp,
          reason: (cause as Error).message
        })
      )
    }
    log.info('savesetup', 'changed a setting save sync depends on', {
      id,
      file,
      key: finding.key,
      before: finding.found,
      after: finding.wanted,
      copy
    })
    return this.items(target)
  }
}
