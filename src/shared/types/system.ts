/**
 * The machine RomMix is running on: where it keeps its files, and what the
 * pre-flight check found.
 */

import type { EmulatorState } from '../../config/emulators/types.ts'

/**
 * What RomMix can ask the machine to do with itself, beyond quitting.
 *
 * For the session where RomMix is the whole of it — a television with no
 * desktop behind it — where the alternative to these is the power button on the
 * case. See `power`.
 */
export type PowerAction = 'suspend' | 'reboot' | 'poweroff'

/** Where RomMix keeps everything it owns. */
export interface RootLocation {
  current: string
  /** What it would be with nothing configured. */
  fallback: string
  /** Set by ROMMIX_HOME, which overrides the stored pointer and cannot be changed here. */
  fromEnvironment: boolean
}

/**
 * The room left on one drive games are written to.
 *
 * `path` is a folder on it rather than the mount point: it is what RomMix was
 * asked about and what the user would recognise — "this is where my Switch
 * games go" — where `/run/media/mmcblk0p1` is a fact about the machine.
 */
export interface DriveSpace {
  path: string
  /** Free to the user running RomMix, which is below what is free to root. */
  freeBytes: number
  totalBytes: number
}

/** Result of the pre-flight check shown on the Settings screen. */
export interface DiagnosticsReport {
  /**
   * Whether `flatpak` is on the machine at all.
   *
   * RomMix does not need it for itself, but most of the emulators it drives are
   * distributed that way, and without it they all report themselves missing for
   * a reason nothing else on the screen would explain.
   */
  flatpakAvailable: boolean
  /**
   * Whether Flathub is a remote of the *user* installation, which is the one
   * RomMix installs into.
   *
   * A separate answer from `flatpakAvailable` because it fails separately and
   * far less visibly: Debian, Ubuntu and Arch ship flatpak with no remotes, and
   * Fedora's Flathub is filtered until enabled. On any of those, every emulator
   * reports itself missing while the row above says flatpak is fine. RomMix adds
   * the remote itself on first install; this is what says so before then.
   */
  flathubConfigured: boolean
  emulators: EmulatorState[]
  /** True when every installed emulator's ROM folder can be written to. */
  romsWritable: boolean
  /**
   * The drives those folders are on, one entry each. See `drivesOf`.
   *
   * Empty where nothing could be measured, which is the same thing the screen
   * says about a drive that will not answer: nothing.
   */
  drives: DriveSpace[]
  /** The log file, so a bug report can name the file rather than hunt for it. */
  logPath: string
  notes: string[]
  /**
   * The emulator settings per-game save sync depends on, or null where no
   * emulator RomMix checks them for is installed. See `SaveSetupReport`.
   */
  saveSetup: SaveSetupReport | null
}

/**
 * One emulator setting that decides where, or in what shape, a save is
 * written — as it stands on this machine.
 *
 * Also what `save-setup.json` holds, which bazzite-maint reads: it re-reads
 * `file` itself and compares `key` against `wanted`, so drift after RomMix last
 * looked is still caught. Field names are part of that contract.
 */
export interface SaveSetupItem {
  id: string
  /** Absolute path of the file the setting is in. */
  file: string
  format: 'ini' | 'cfg' | 'esde-gamelist'
  /** The INI section, where the format has sections. */
  section: string | null
  key: string
  wanted: string
  /** The value there now, or null where the key or the file is absent. */
  found: string | null
  status: 'ok' | 'drift' | 'missing-file' | 'report-only' | 'unreadable'
  /** Whether RomMix can set it (`edit`), or only say so. */
  fix: 'edit' | 'report-only'
  /** Why it matters, in the language RomMix is set to. */
  reason: string
}

/** Every save-relevant setting of one emulator install, and when it was read. */
export interface SaveSetupReport {
  /** The version of this shape, raised when a reader would misread the next. */
  schema: 1
  /** The RomMix version that wrote it. */
  rommix: string
  checkedAt: string
  emulator: string
  items: SaveSetupItem[]
}
