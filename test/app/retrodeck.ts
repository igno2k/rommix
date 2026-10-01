import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { POLL_MS, SETTLE_TIMEOUT_MS } from './driver.ts'

/**
 * A RetroDECK install that is a home directory and a shell script.
 *
 * RomMix finds RetroDECK by asking flatpak where it is deployed, reads where
 * its library is from `retrodeck.json` in the flatpak's own config tree, and
 * starts a game with `flatpak run`. So the whole of RetroDECK, as far as RomMix
 * can tell, is a `flatpak` first on the `PATH` that answers those questions, a
 * `HOME` holding the config, and a PCSX2 folder memory card under the saves
 * folder. Handed to `startApp` as `env`.
 *
 * `run` stands in for PCSX2 the way `standInEmulator` stands in for any other
 * emulator: it writes down what the game's save held when it started — the
 * only race-free account of whether the pull came first — and, where the test
 * asked for one, writes a new save, then stays up past the launcher's startup
 * grace. It answers to every other flatpak question as an installation that
 * holds RetroDECK and nothing else.
 */

export const RETRODECK_ID = 'net.retrodeck.retrodeck'

/** Relative path inside a folder -> contents. */
export type Tree = Readonly<Record<string, string | Buffer>>

export interface FakeRetroDeck {
  /** For `startApp`'s `env`: the home, and the `flatpak` it finds first. */
  env: Record<string, string>
  /** RetroDECK's library folder, `~/retrodeck`. */
  root: string
  /** The PCSX2 folder card, `saves/ps2/pcsx2/memcards/Mcd001.ps2`. */
  card: string
  /** `PCSX2.ini`, in the flatpak's config tree. */
  ini: string
  /**
   * What the next session writes into the card while it runs: a path inside
   * the card and its contents. Null writes nothing.
   */
  session: (write: { path: string; content: string } | null) => void
  /** What that path held when the session started — kept outside the card. */
  found: () => Promise<string | null>
}

/** How long a session lasts. Past `Launcher`'s grace, as `standInEmulator`'s does. */
const SESSION_SECONDS = 8

/**
 * When the card was last played on this device: well before any copy the
 * server holds, so a newer one there is one worth bringing down.
 */
const LAST_PLAYED = new Date('2026-01-01T00:00:00Z')

/** Write a tree under `root`, folders implied, optionally dated `at`. */
export function plant(root: string, tree: Tree, at?: Date): void {
  for (const [path, contents] of Object.entries(tree)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), contents)
    if (at) utimesSync(join(root, path), at, at)
  }
}

/** Every file under `root`, relative path -> sha256, minus the folders `skip` names. */
export function hashes(root: string, skip: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const rel = relative(root, path)
      if (skip.some((member) => rel === member || rel.startsWith(`${member}/`))) continue
      if (entry.isDirectory()) visit(path)
      else out[rel] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  visit(root)
  return out
}

/**
 * `card` is what is on the folder card; `ini` is `PCSX2.ini`, given the saves
 * folder, which RetroDECK writes into it as an absolute path.
 */
export function fakeRetroDeck(options: {
  card: Tree
  ini: (saves: string) => string
}): FakeRetroDeck {
  const home = mkdtempSync(join(tmpdir(), 'rommix-retrodeck-'))
  const root = join(home, 'retrodeck')
  const config = join(home, '.var', 'app', RETRODECK_ID, 'config')
  const install = join(home, 'flatpak', RETRODECK_ID)
  const bin = join(home, 'bin')
  const card = join(root, 'saves', 'ps2', 'pcsx2', 'memcards', 'Mcd001.ps2')
  const ini = join(config, 'PCSX2', 'inis', 'PCSX2.ini')
  const control = join(home, 'session')
  const foundAt = join(home, 'found')
  const running = join(home, 'running')

  for (const dir of ['roms', 'saves', 'states', 'bios'])
    mkdirSync(join(root, dir), { recursive: true })
  mkdirSync(install, { recursive: true })
  plant(config, {
    'retrodeck/retrodeck.json': JSON.stringify({
      paths: {
        rd_home_path: root,
        roms_path: join(root, 'roms'),
        saves_path: join(root, 'saves'),
        states_path: join(root, 'states'),
        bios_path: join(root, 'bios')
      }
    }),
    'PCSX2/inis/PCSX2.ini': options.ini(join(root, 'saves'))
  })
  plant(card, options.card, LAST_PLAYED)

  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'flatpak'),
    [
      '#!/bin/sh',
      'case "$1" in',
      `  info) [ "$2" = --show-location ] && [ "$3" = ${RETRODECK_ID} ] && echo ${JSON.stringify(install)} && exit 0; exit 1 ;;`,
      '  --version) echo "Flatpak 1.16.0" ;;',
      '  remotes) echo flathub ;;',
      // RetroDECK is running while a session is, as `flatpak ps` lists it.
      `  ps) [ "$2" = --columns=application ] && [ -f ${JSON.stringify(running)} ] && echo ${RETRODECK_ID}; exit 0 ;;`,
      '  kill) ;;',
      '  run)',
      '    shift',
      '    while [ "${1#--}" != "$1" ]; do shift; done',
      `    [ "$1" = ${RETRODECK_ID} ] || exit 1`,
      // `found` before anything is written, empty where there was nothing —
      // see `standInEmulator`, whose reasons are these.
      `    if [ -f ${JSON.stringify(control)} ]; then`,
      `      target=${JSON.stringify(card)}/$(sed -n 1p ${JSON.stringify(control)})`,
      `      cp "$target" ${JSON.stringify(foundAt)} 2>/dev/null || : > ${JSON.stringify(foundAt)}`,
      `      sed -n '2,$p' ${JSON.stringify(control)} | tr -d '\\n' > "$target"`,
      '    fi',
      `    : > ${JSON.stringify(running)}`,
      `    left=${SESSION_SECONDS}`,
      '    while [ "$left" -gt 0 ]; do sleep 1; left=$((left - 1)); done',
      `    rm -f ${JSON.stringify(running)}`,
      '    ;;',
      '  *) exit 1 ;;',
      'esac',
      ''
    ].join('\n'),
    { mode: 0o755 }
  )

  return {
    env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` },
    root,
    card,
    ini,
    session: (write) => {
      rmSync(foundAt, { force: true })
      if (write) writeFileSync(control, `${write.path}\n${write.content}`)
      else rmSync(control, { force: true })
    },
    found: async () => {
      const until = Date.now() + SETTLE_TIMEOUT_MS
      while (Date.now() < until) {
        if (existsSync(foundAt)) return readFileSync(foundAt, 'utf8')
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
      return null
    }
  }
}
