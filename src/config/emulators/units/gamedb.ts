import type { SaveEnvironment } from '../savepaths.ts'
import { ps2Stems } from './keys.ts'

/**
 * What a PS2 folder card needs from PCSX2's game database: which save folders
 * each game is shown, and which game a serial is.
 *
 * With folder cards managed per game (`McdFolderAutoManage`) PCSX2 does not
 * show a game the whole card. It builds a filter — the game's `memcardFilters`
 * from `GameIndex.yaml` joined with `/` where the entry has any, the disc
 * serial otherwise (`VMManager.cpp`, `FileMcd_Reopen`) — and indexes only the
 * folders whose name contains one of its parts (`FilterMatches` in
 * `SIO/Memcard/MemoryCardFolder.cpp`). The filters are how a sequel reads the
 * first game's save for a bonus and how the discs of one game share a save,
 * so a unit without them leaves part of what the game uses behind.
 *
 * The names are for the other direction: two ROMs RomM files under one serial
 * — a game and an add-on sold on the same disc — cannot both own that serial's
 * folders, and the database says which game the serial is.
 *
 * Read rather than copied into RomMix: the lists are PCSX2's and change with
 * it, and the database ships inside every PCSX2 build.
 */

/** The file PCSX2 loads its game database from, in its resources folder. */
export const PCSX2_GAMEDB_FILE = 'GameIndex.yaml'

/** One entry, as far as a folder card is concerned. */
export interface GameDbEntry {
  /** `name`, `name-en` and `name-sort`, whichever the entry has. */
  names: string[]
  /** `memcardFilters`, empty items dropped. */
  filters: string[]
}

/** Serial, reduced by `normalizeForMatch` -> its entry. */
export type Pcsx2GameDb = ReadonlyMap<string, GameDbEntry>

/** A top-level key: a serial at column 0, nothing after the colon but a comment. */
const ENTRY = /^([^\s#][^:]*):\s*(?:#.*)?$/

/** The filter list, at whatever depth the entry's fields sit. */
const FILTERS = /^(\s+)memcardFilters:\s*(.*)$/

/** One of the entry's names. */
const NAME = /^\s+(?:name|name-en|name-sort):\s*(.*)$/

/** One item of a block sequence. */
const ITEM = /^(\s*)-\s*(.*)$/

/**
 * A scalar as YAML would read it here: the text between its quotes where it is
 * quoted, the text before a comment where it is not.
 */
function scalar(raw: string): string {
  const text = raw.trim()
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1)
    return end === -1 ? text.slice(1).trim() : text.slice(1, end)
  }
  const comment = text.search(/\s#/)
  return (comment === -1 ? text : text.slice(0, comment)).trim()
}

/** The items of a flow sequence, `["SLUS-20001", "SLUS-20002"]`. */
function flowItems(raw: string): string[] {
  const open = raw.indexOf('[')
  const close = raw.lastIndexOf(']')
  if (open === -1 || close < open) return []
  return raw
    .slice(open + 1, close)
    .split(',')
    .map(scalar)
}

/**
 * Every entry keyed by a serial, with its names and its `memcardFilters`.
 *
 * A line scanner for these fields rather than a YAML parser: RomMix has no
 * YAML library, and pulling one in to read three fields out of a file this
 * regular is not worth a dependency. It reads the two shapes YAML allows for a
 * list — a block of `- item` lines under the field, and `[a, b]` on the
 * field's own line — and ignores everything else. An entry it misreads has no
 * filters, and that is the serial rule the game would have without the
 * database.
 *
 * Empty filters are dropped: an empty filter is contained in every name, and a
 * unit holding the whole card is worse than one missing a folder.
 */
export function parseGameDb(yaml: string): Map<string, GameDbEntry> {
  const found = new Map<string, GameDbEntry>()
  let entry: GameDbEntry | null = null
  /** The block list being read, and the indentation of its field. */
  let list: { items: string[]; indent: number } | null = null

  const keep = (items: readonly string[]): void => {
    if (entry) entry.filters.push(...items.filter((item) => item !== ''))
  }

  for (const line of yaml.split(/\r?\n/)) {
    if (list) {
      const item = ITEM.exec(line)
      if (item && item[1].length >= list.indent) {
        list.items.push(scalar(item[2]))
        continue
      }
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      keep(list.items)
      list = null
    }

    const top = ENTRY.exec(line)
    if (top) {
      const serial = ps2Stems(scalar(top[1]))[1]
      entry = serial ? { names: [], filters: [] } : null
      if (serial && entry) found.set(serial, entry)
      continue
    }
    if (!entry) continue
    const name = NAME.exec(line)
    if (name) {
      const value = scalar(name[1])
      if (value) entry.names.push(value)
      continue
    }
    const field = FILTERS.exec(line)
    if (!field) continue
    const rest = field[2].trim()
    if (rest.startsWith('[')) keep(flowItems(rest))
    else list = { items: [], indent: field[1].length }
  }
  if (list) keep(list.items)
  return found
}

/** The entry for the game RomM keyed as `key`, `SLUS-20152` or `BASLUS-20152` alike. */
function entryFor(db: Pcsx2GameDb, key: string): GameDbEntry | undefined {
  const serial = ps2Stems(key)[1]
  return serial ? db.get(serial) : undefined
}

/**
 * The filters PCSX2 applies for the game RomM keyed as `key`. Empty where the
 * entry has none, which is most of them.
 */
export function memcardFiltersFor(db: Pcsx2GameDb, key: string): readonly string[] {
  return entryFor(db, key)?.filters ?? []
}

/**
 * A title reduced to what a ROM's file name and the database agree on: no
 * `(USA)` or `[!]`, no leading or trailing "The", letters and digits only, in
 * lower case. `Legend of Spyro, The - Dawn of the Dragon (USA)` and
 * `The Legend of Spyro - Dawn of the Dragon` are one title.
 */
export function titleKey(title: string): string {
  return title
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/,\s*the\b/g, ' ')
    .trim()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Is the ROM called `romTitle` the game the database files `key` under?
 *
 * False where the database has no entry or no name for the serial, as well as
 * where the names differ: the serial's folders are then another game's as far
 * as this ROM can tell. A name that reduces to nothing — one written only in
 * kana — matches nothing.
 */
export function isGameDbTitle(db: Pcsx2GameDb, key: string, romTitle: string): boolean {
  const wanted = titleKey(romTitle)
  if (!wanted) return false
  return (entryFor(db, key)?.names ?? []).some((name) => titleKey(name) === wanted)
}

/**
 * Databases already read, keyed by the environment that read them and then by
 * path — the same arrangement as the BIOS manifests, so the cache lives exactly
 * as long as whatever handed out the environment: the process in the app, one
 * fake machine in a test.
 *
 * Only a database that was there is kept. A missing one is asked about again
 * next time, which costs one failed read and means a PCSX2 installed after
 * RomMix started is seen without a restart.
 */
const CACHE = new WeakMap<object, Map<string, Pcsx2GameDb>>()

/**
 * The database at `path`, parsed once per environment; null where it cannot be
 * read, or where what is there holds no entry at all.
 */
export function readGameDb(env: SaveEnvironment, path: string): Pcsx2GameDb | null {
  let byPath = CACHE.get(env)
  const cached = byPath?.get(path)
  if (cached) return cached

  const text = env.text(path)
  if (text === null) return null
  const db = parseGameDb(text)
  // PCSX2's own database has thousands of entries; a file with none is not one.
  if (db.size === 0) return null
  if (!byPath) {
    byPath = new Map()
    CACHE.set(env, byPath)
  }
  byPath.set(path, db)
  return db
}
