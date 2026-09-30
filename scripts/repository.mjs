// Which GitHub repository this copy of RomMix is published from, read out of
// package.json's `repository` field.
//
// One answer for everything that points at the project: the updater's API
// calls and releases page (through a `define` in electron.vite.config.ts), the
// release notes' links, the landing page and the demo. A fork sets the field
// and every one of those follows — including, and most of all, where a copy
// looks for its next version, which for a fork has to be the fork's own
// releases rather than the upstream ones it would otherwise replace itself
// with.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * `owner/name` from the `repository` field, in any of the shapes npm accepts
 * for GitHub: `owner/name`, `github:owner/name`, a URL, or an object with one.
 *
 * Throws where it names no GitHub repository, so a build cannot quietly ship
 * pointing nowhere — or anywhere it did not mean to.
 */
export function repositoryOf(pkg) {
  const field = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const match =
    /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(field ?? '') ??
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(field ?? '')
  if (!match) throw new Error(`package.json names no GitHub repository: ${JSON.stringify(field)}`)
  return `${match[1]}/${match[2]}`
}

/** The repository of the package.json in `root`. */
export function repository(root = '.') {
  return repositoryOf(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')))
}
