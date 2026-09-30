import type { Text } from '@shared/i18n'
import { coreForSystem } from '../../systems.ts'
import { iniValue } from '../ini.ts'
import { libretroSavePaths, readLibretroConfig, LIBRETRO_TAG } from '../libretro.ts'
import { baseName, directory, joinPath, perRom, shared, unit } from '../savepaths.ts'
import type { SaveContext, SaveLocation, SavePaths, SaveUnit } from '../savepaths.ts'
import { dreamcastUnit } from '../units/dc.ts'
import { dolphinRegion, gameCubeUnit } from '../units/gc.ts'
import { gameCubeId, GAMECUBE_HEAD_BYTES } from '../units/keys.ts'
import { ps2Unit, PS2_SUPERBLOCK } from '../units/ps2.ts'
import { pspUnit } from '../units/psp.ts'
import { RETRODECK_APP_ID } from './appid.ts'

/**
 * Where RetroDECK's bundled emulators keep their saves.
 *
 * RetroDECK is a dispatcher, so "where does RetroDECK put saves" has no single
 * answer — it puts them wherever the component it chose puts them, and it moves
 * each component's directory into its own tree during setup. Every path below
 * is taken from the `component_prepare.sh` that performs that move, in
 * RetroDECK's own components repository, and verified against a live
 * `~/retrodeck`.
 *
 * The shape is *mostly* `<saves>/<system>/<component>/…`, and the exceptions are
 * why each component answers for itself rather than setting a flag: Dolphin and
 * PrimeHack put their states at `<states>/<component>` with no system at all,
 * MAME uses `mame-sa` in place of a system, PPSSPP's folder is `PSP` in capitals
 * where the ES-DE system is `psp`, and XRoar inverts the two.
 */

/** How a component arranges one game's data, given the discovered roots. */
type ComponentSaves = (ctx: SaveContext) => SavePaths

const savesRoot = (ctx: SaveContext): string | null => ctx.paths.saves
const statesRoot = (ctx: SaveContext): string | null => ctx.paths.states

/** `<root>/<segments…>`, or null when the root was never discovered. */
function under(root: string | null, ...segments: readonly string[]): string | null {
  return root ? joinPath(root, ...segments) : null
}

/** A location, or null when its root is missing. */
function at(path: string | null, make: (dir: string) => SaveLocation): SaveLocation | null {
  return path ? make(path) : null
}

/**
 * The memory-card emulators.
 *
 * DuckStation is configured by RetroDECK with a *shared* card,
 * `shared_card_1.mcd`, rather than one per game. Its save states are per-game
 * and are synced; the card is not, because it holds every PS1 game the user
 * has played and uploading it under one game's id would attach the lot to
 * that game.
 */
function cardEmulator(component: string, reason: Text): ComponentSaves {
  return (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, component, 'memcards'), shared),
    states: at(under(statesRoot(ctx), ctx.system, component), (dir) => perRom(dir)),
    unsyncableReason: reason
  })
}

/** A component's config file, below the flatpak's config root. */
function configText(ctx: SaveContext, ...segments: readonly string[]): string | null {
  return ctx.configDir ? ctx.env.text(joinPath(ctx.configDir, ...segments)) : null
}

/** A shared folder with the reason nothing in it can be synced. */
function unsyncable(
  dir: string | null,
  reason: Text
): Pick<SavePaths, 'saves' | 'unsyncableReason'> {
  return { saves: at(dir, shared), unsyncableReason: reason }
}

/**
 * The folder memory card PCSX2 has in slot 1, or why there is none to sync.
 *
 * RetroDECK ships PCSX2 with folder cards managed per game
 * (`McdFolderAutoManage`), and a folder card is a directory holding PCSX2's
 * `_pcsx2_superblock` beside one folder per save — which is what lets one
 * game's saves be told apart at all. The card is the one `[MemoryCards]
 * Slot1_Filename` names in `PCSX2.ini`, `Mcd001.ps2` in the config RetroDECK
 * ships. Where the ini cannot be read the card is the only folder card there
 * is, and two of them is a choice RomMix will not guess at, as Argosy will not.
 *
 * A card that is still a raw image is reported rather than converted: that is
 * a migration of every game's saves at once, and PCSX2's own memory-card
 * settings do it.
 */
function pcsx2Card(ctx: SaveContext, memcards: string): { dir: string } | { reason: Text } {
  const named = iniValue(
    configText(ctx, 'PCSX2', 'inis', 'PCSX2.ini'),
    'MemoryCards',
    'Slot1_Filename'
  )
  if (named) {
    const dir = joinPath(memcards, named)
    return ctx.env.exists(joinPath(dir, PS2_SUPERBLOCK)) ? { dir } : { reason: 'saves.pcsx2NoCard' }
  }
  const cards = ctx.env
    .dirs(memcards)
    .filter((name) => ctx.env.exists(joinPath(memcards, name, PS2_SUPERBLOCK)))
  if (cards.length > 1) return { reason: 'saves.pcsx2CardAmbiguous' }
  return cards.length === 1
    ? { dir: joinPath(memcards, cards[0]) }
    : { reason: 'saves.pcsx2NoCard' }
}

/**
 * The key RomM read out of this game, where the server sent one.
 *
 * Without it a game's entries on a shared card cannot be told from another's,
 * so the answer is "nothing here is this game's" and a reason that says to
 * rescan on a server that reads them.
 */
function saveKey(ctx: SaveContext): string | null {
  return ctx.saveTarget?.key.trim() || null
}

/**
 * The GameCube disc id, from the image first and RomM's reading second.
 *
 * The image is the authority Dolphin itself uses, and reading six bytes of it
 * costs nothing where the image is a plain ISO or an RVZ. RomM's key stands in
 * for the containers that compress the header away, and only where it has the
 * shape of a disc id: a server that sends something else for GameCube is not
 * one to pair saves on.
 */
function gameCubeKey(ctx: SaveContext): string | null {
  const read = gameCubeId(ctx.env.head(ctx.romPath, GAMECUBE_HEAD_BYTES))
  if (read) return read
  const key = saveKey(ctx)?.toUpperCase() ?? null
  return key && /^[A-Z0-9]{4}([A-Z0-9]{2})?$/.test(key) ? key : null
}

/**
 * A unit that must not be written while RetroDECK — anything in its sandbox —
 * or the emulator itself runs. `program` is the emulator's executable as it
 * appears on the command line.
 */
function guarded(rule: SaveUnit, program: string): SaveUnit {
  return { ...rule, busyWhile: { name: 'RetroDECK', markers: [RETRODECK_APP_ID, program] } }
}

/**
 * The links RetroDECK makes from its own saves tree into Dolphin's per-region
 * card folders — `saves/gc/dolphin/US` for Dolphin's `GC/USA`, and so on — in
 * its `component_prepare.sh`.
 */
const DOLPHIN_REGION_LINKS: Readonly<Record<'USA' | 'EUR' | 'JAP', string>> = {
  USA: 'US',
  EUR: 'EU',
  JAP: 'JP'
}

export const RETRODECK_COMPONENTS: Readonly<Record<string, ComponentSaves>> = {
  /**
   * PCSX2's saves are the game's own folders on the folder card in slot 1.
   * Its states are per-game files named after the ROM.
   */
  pcsx2: (ctx) => {
    const states = at(under(statesRoot(ctx), ctx.system, 'pcsx2'), (dir) => perRom(dir))
    const memcards = under(savesRoot(ctx), ctx.system, 'pcsx2', 'memcards')
    if (!memcards) return { saves: null, states }

    const card = pcsx2Card(ctx, memcards)
    if ('reason' in card) return { ...unsyncable(memcards, card.reason), states }
    const key = saveKey(ctx)
    const rule = key ? ps2Unit(key) : null
    if (!rule) return { ...unsyncable(memcards, 'saves.noSaveTarget'), states }
    return { saves: unit(card.dir, guarded(rule, 'pcsx2-qt')), states }
  },
  duckstation: cardEmulator('duckstation', 'saves.retrodeckDuckstation'),

  /**
   * Dolphin keeps GameCube saves as one `.gci` per save in a folder per region
   * when slot A is set to "GCI Folder" (`SlotA = 8`), which is what RetroDECK
   * ships — and then a game's own files can be told apart by the disc id in
   * their headers. A raw card image in slot A, or a folder moved elsewhere with
   * `GCIFolderAPath`, is a layout RomMix does not write into. The Wii NAND is
   * one tree for every game and stays shared.
   *
   * States are per-game, and sit at `<states>/dolphin` — no system component
   * at all, which is why the layout is spelled out per component here rather
   * than derived.
   */
  dolphin: (ctx) => {
    const states = at(under(statesRoot(ctx), 'dolphin'), (dir) => perRom(dir))
    const cards = under(savesRoot(ctx), ctx.system, 'dolphin')
    if (ctx.system !== 'gc' || !cards) return { ...unsyncable(cards, 'saves.dolphin'), states }

    const ini = configText(ctx, 'dolphin-emu', 'Dolphin.ini')
    const slotA = iniValue(ini, 'Core', 'SlotA')
    const moved = iniValue(ini, 'Core', 'GCIFolderAPath')
    if ((slotA !== null && slotA !== '8') || moved) {
      return { ...unsyncable(cards, 'saves.dolphin'), states }
    }
    const key = gameCubeKey(ctx)
    if (!key) return { ...unsyncable(cards, 'saves.noSaveTarget'), states }
    const region = DOLPHIN_REGION_LINKS[dolphinRegion(key)]
    return {
      saves: unit(
        joinPath(cards, region, 'Card A'),
        guarded(gameCubeUnit(key, ctx.env), 'dolphin-emu')
      ),
      states
    }
  },
  primehack: (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, 'primehack'), shared),
    states: at(under(statesRoot(ctx), 'primehack'), (dir) => perRom(dir)),
    unsyncableReason: 'saves.primehack'
  }),

  /** melonDS names both its `.sav` and its states after the ROM. */
  melonds: (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, 'melonds'), (dir) => perRom(dir)),
    states: at(under(statesRoot(ctx), ctx.system, 'melonds'), (dir) => perRom(dir))
  }),

  /**
   * MAME files its nvram under the ROM's own short name, which is what a MAME
   * set is called — and is exactly the ROM file's stem. `mame-sa` stands where
   * a system would.
   */
  mame: (ctx) => ({
    saves: at(under(savesRoot(ctx), 'mame-sa', 'nvram'), (dir) => perRom(dir)),
    states: at(under(statesRoot(ctx), 'mame-sa'), (dir) => perRom(dir))
  }),

  ruffle: (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, 'ruffle'), (dir) => perRom(dir)),
    states: null
  }),

  /**
   * PPSSPP keeps one directory per save, named after the game *id* read out of
   * the ISO's PARAM.SFO — RetroDECK links its `PSP/SAVEDATA` to
   * `saves/PSP/PPSSPP-SA` — so a game's saves are the folders starting with the
   * disc id RomM read. Its states are named after that id too, with nothing a
   * ROM can be matched on, and stay unsynced.
   */
  ppsspp: (ctx) => {
    const states = at(under(statesRoot(ctx), 'PSP', 'PPSSPP-SA'), shared)
    const savedata = under(savesRoot(ctx), 'PSP', 'PPSSPP-SA')
    const key = saveKey(ctx)
    const rule = key ? pspUnit(key, ctx.env) : null
    if (!savedata || !rule) return { ...unsyncable(savedata, 'saves.ppsspp'), states }
    return { saves: unit(savedata, guarded(rule, 'PPSSPP')), states }
  },
  rpcs3: (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, 'rpcs3'), shared),
    states: at(under(statesRoot(ctx), ctx.system, 'rpcs3'), shared),
    unsyncableReason: 'saves.rpcs3'
  }),
  cemu: (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, 'cemu'), shared),
    states: null,
    unsyncableReason: 'saves.cemu'
  }),
  vita3k: (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, 'vita3k'), shared),
    states: null,
    unsyncableReason: 'saves.vita3k'
  }),
  azahar: (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, 'azahar', 'sdmc'), shared),
    states: null,
    unsyncableReason: 'saves.azahar'
  }),
  xemu: (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, 'xemu'), shared),
    states: null,
    unsyncableReason: 'saves.xemu'
  }),
  xroar: (ctx) => ({
    saves: null,
    states: at(under(statesRoot(ctx), 'xroar', ctx.system), (dir) => perRom(dir)),
    unsyncableReason: 'saves.xroar'
  }),
  solarus: (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, 'solarus'), directory),
    states: null
  }),
  gzdoom: (ctx) => ({
    saves: at(under(savesRoot(ctx), ctx.system, 'gzdoom'), (dir) => perRom(dir)),
    states: null
  })
}

/**
 * Where RetroDECK keeps the ES-DE system list, below its deploy directory.
 *
 * The same file `run_game.sh` consults: its `component_functions.sh` sets
 * `es_systems` to exactly this path inside the sandbox, and `installDir` is
 * where that sandbox's files are on the host.
 */
const ES_SYSTEMS =
  'files/retrodeck/components/es-de/share/es-de/resources/systems/linux/es_systems.xml'

/**
 * The label of the first `<command>` ES-DE lists for a system.
 *
 * This is RetroDECK's own last resort — "no altemulator set, so use the first
 * one" — and reading it means RomMix agrees with RetroDECK by construction
 * rather than by a table that has to be revised every time RetroDECK changes a
 * default.
 *
 * The system blocks are matched one at a time rather than with a single
 * expression spanning `<name>` and `<command>`, because a greedy match across
 * a file of two hundred systems would happily pair one system's name with
 * another's command.
 */
function defaultCommandLabel(
  env: SaveContext['env'],
  installDir: string,
  system: string
): string | null {
  const block = systemBlock(env, installDir, system)
  if (!block) return null
  return /<command\s+label="([^"]*)"/.exec(block)?.[1] ?? null
}

/** The `<system>` ES-DE lists this system under, unparsed. */
function systemBlock(env: SaveContext['env'], installDir: string, system: string): string | null {
  const xml = env.text(joinPath(installDir, ES_SYSTEMS))
  if (!xml) return null

  for (const [, block] of xml.matchAll(/<system>([\s\S]*?)<\/system>/g)) {
    const name = /<name>\s*([\s\S]*?)\s*<\/name>/.exec(block)?.[1]
    if (name === system) return block
  }
  return null
}

/**
 * The libretro core the command ES-DE would run loads, read off the command
 * itself.
 *
 * RetroDECK's commands name the core file — `%EMULATOR_RETROARCH% -L
 * %CORE_RETROARCH%/mupen64plus_next_libretro.so %ROM%` — so the core is a
 * capture from the very line that runs, with no table in between and nothing to
 * keep up to date when RetroDECK changes a default. The label, which is what
 * `retroDeckComponent` matches on, is a display name and cannot be turned into
 * a core id: "Mupen64Plus-Next" is not `mupen64plus_next` by any rule that also
 * survives "Beetle PSX HW".
 *
 * `label` is the `<altemulator>` the game or the system is set to; null means
 * nothing overrides ES-DE's own first choice, which is the first command listed.
 */
function coreForCommand(ctx: ComponentContext, label: string | null): string | null {
  if (!ctx.installDir) return null
  const block = systemBlock(ctx.env, ctx.installDir, ctx.system)
  if (!block) return null

  for (const [, attributes, command] of block.matchAll(/<command([^>]*)>([\s\S]*?)<\/command>/g)) {
    if (label !== null && /label="([^"]*)"/.exec(attributes)?.[1] !== label) continue
    return /([A-Za-z0-9_-]+)_libretro\.(?:so|dll|dylib)/.exec(command)?.[1] ?? null
  }
  return null
}

/**
 * The component ES-DE hands a system to, when ES-DE's own list cannot be read.
 *
 * A copy of the first `<command>` of each system in the `es_systems.xml`
 * RetroDECK bundles, kept only for the case where the deploy directory is not
 * where RomMix could look — a RetroDECK installed some way flatpak does not
 * report. Every system absent from here defaults to a core inside RetroArch,
 * which is the large majority of them and needs no entry.
 */
export const RETRODECK_DEFAULT_COMPONENT: Readonly<Record<string, string>> = {
  gc: 'dolphin',
  wii: 'dolphin',
  triforce: 'dolphin',
  ps2: 'pcsx2',
  ps3: 'rpcs3',
  psp: 'ppsspp',
  psvita: 'vita3k',
  n3ds: 'azahar',
  wiiu: 'cemu',
  xbox: 'xemu',
  flash: 'ruffle',
  doom: 'gzdoom',
  solarus: 'solarus',
  coco: 'xroar',
  dragon32: 'xroar',
  tanodragon: 'xroar'
}

/**
 * ES-DE command labels that name a standalone component rather than a core.
 *
 * ES-DE labels a standalone command "<Name> (Standalone)" by convention, so the
 * suffix alone tells a core from a program; what it does not give is the
 * directory RetroDECK moved that program's saves into, which is what this maps
 * to. A label RomMix does not recognise falls back to RetroArch, because every
 * unrecognised label in practice *is* a core — there are hundreds of those and
 * a fixed handful of components.
 */
export const COMPONENT_BY_LABEL: Readonly<Record<string, string>> = {
  pcsx2: 'pcsx2',
  duckstation: 'duckstation',
  dolphin: 'dolphin',
  primehack: 'primehack',
  ppsspp: 'ppsspp',
  rpcs3: 'rpcs3',
  'rpcs3 shortcut': 'rpcs3',
  vita3k: 'vita3k',
  azahar: 'azahar',
  cemu: 'cemu',
  xemu: 'xemu',
  ruffle: 'ruffle',
  gzdoom: 'gzdoom',
  solarus: 'solarus',
  melonds: 'melonds',
  mame: 'mame',
  xroar: 'xroar'
}

/**
 * Standalone programs ES-DE does not mark with the usual suffix.
 *
 * A short list on purpose — it is the exception to the rule below, and every
 * entry has to be checked against ES-DE's own list rather than guessed.
 */
const UNSUFFIXED_STANDALONES = new Set(['bigpemu', 'portmaster'])

/**
 * Reduce an ES-DE command label to the component it names, or null for a core.
 *
 * ES-DE labels a standalone command "<Name> (Standalone)" and a libretro core
 * by the core's own name, and that suffix is the only thing separating the two.
 * Ignoring it gets arcade badly wrong: the default there is "MAME - Current",
 * which is `mame_libretro.so` inside RetroArch — matching it on the word "MAME"
 * would send save sync to the standalone's `saves/mame-sa/nvram` tree, which
 * the core never writes to.
 *
 * Whatever survives the suffix still carries qualifiers the component name does
 * not — "MAME [Diskette] (Standalone)", "XRoar CoCo 2 NTSC (Standalone)" — so
 * the bracketed parts come off and the leading words are what is matched.
 */
function componentForLabel(label: string): string | null {
  const bare = label
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim()
    .toLowerCase()
  if (!bare) return null

  const standalone = /\(standalone\)/i.test(label) || UNSUFFIXED_STANDALONES.has(bare)
  if (!standalone) return null

  if (COMPONENT_BY_LABEL[bare]) return COMPONENT_BY_LABEL[bare]
  // "XRoar CoCo 2 NTSC" and friends: the program is the first word.
  return COMPONENT_BY_LABEL[bare.split(/\s+/)[0]] ?? null
}

/**
 * What resolving a component needs, which is less than a whole `SaveContext`.
 *
 * Named separately so BIOS placement can ask the same question: a BIOS file
 * belongs to a system rather than to a game, so there is no ROM to look up a
 * per-game override with, and everything below the first step still applies.
 */
export interface ComponentContext {
  paths: { home: string | null }
  system: string
  /** The game being launched, or null when the question is about a system. */
  romPath: string | null
  installDir: string | null
  env: SaveContext['env']
}

/**
 * The emulator RetroDECK will actually run this game with.
 *
 * Replicates `run_game.sh`'s own resolution, in its order: the per-game
 * `<altemulator>` recorded in ES-DE's gamelist, then the per-system
 * `<alternativeEmulator>` header in the same file, then the bundled default.
 * Reading it rather than choosing it is deliberate — RomMix launches RetroDECK
 * by system precisely so the user's own ES-DE configuration decides, and a save
 * path that disagreed with that choice would be a save written where nothing
 * looks.
 */
export function retroDeckComponent(ctx: ComponentContext): string {
  const label = commandLabel(ctx)
  // A recognised label names a standalone; an unrecognised one still means "a
  // core", which is what the RetroArch fallback is.
  if (label) return componentForLabel(label) ?? 'retroarch'
  return RETRODECK_DEFAULT_COMPONENT[ctx.system] ?? 'retroarch'
}

/**
 * The label of the command ES-DE runs a whole system with: the gamelist's
 * `<alternativeEmulator>`, or the first command ES-DE lists. Null where neither
 * can be read.
 */
export function retroDeckSystemLabel(ctx: Omit<ComponentContext, 'romPath'>): string | null {
  return commandLabel({ ...ctx, romPath: null })
}

/**
 * The `<altemulator>` in force for this game, or the label of the command ES-DE
 * would otherwise run.
 *
 * Null means neither could be read, which is the only case the table of
 * defaults is for. A game's own override wins outright: where the gamelist
 * names one, ES-DE does not consult the system list at all, so neither does
 * this.
 */
function commandLabel(ctx: ComponentContext): string | null {
  const gamelist = ctx.paths.home
    ? ctx.env.text(joinPath(ctx.paths.home, 'ES-DE', 'gamelists', ctx.system, 'gamelist.xml'))
    : null

  if (gamelist) {
    const label = altEmulatorFor(gamelist, ctx.romPath ? baseName(ctx.romPath) : null)
    if (label) return label
  }

  // Nothing overrides it, so ES-DE takes the first command it lists — read from
  // the very file RetroDECK reads rather than from a copy of its conclusions.
  if (ctx.installDir) return defaultCommandLabel(ctx.env, ctx.installDir, ctx.system)
  return null
}

/**
 * The `<altemulator>` that applies to one game, or the system-wide
 * `<alternativeEmulator>` when the game has none.
 *
 * ES-DE writes the per-game override inside the `<game>` block whose `<path>`
 * is `./<file name>`, and the system-wide one in an `<alternativeEmulator>`
 * header before the entries. Parsed with regular expressions rather than an XML
 * parser: these are two named elements in a file that can hold thousands of
 * games, and pulling in a parser to read two strings would cost more than it
 * explains.
 */
function altEmulatorFor(gamelist: string, romFileName: string | null): string | null {
  const games = romFileName ? gamelist.matchAll(/<game>([\s\S]*?)<\/game>/g) : []
  for (const [, block] of games) {
    const path = /<path>\s*([\s\S]*?)\s*<\/path>/.exec(block)?.[1]
    if (!path) continue
    if (baseName(path) !== romFileName) continue
    const alt = /<altemulator>\s*([\s\S]*?)\s*<\/altemulator>/.exec(block)?.[1]
    if (alt) return alt
    // The game is listed and names no override, so the system-wide one applies.
    break
  }
  return (
    /<alternativeEmulator>[\s\S]*?<label>\s*([\s\S]*?)\s*<\/label>[\s\S]*?<\/alternativeEmulator>/.exec(
      gamelist
    )?.[1] ?? null
  )
}

/** Where RetroDECK's chosen component keeps this game's saves. */
export function retroDeckSavePaths(ctx: SaveContext): SavePaths {
  const component = retroDeckComponent(ctx)

  const known = RETRODECK_COMPONENTS[component]
  // `emulator` is the component rather than "retrodeck": a save written by
  // RetroDECK's PCSX2 is a PCSX2 save, and tagging it with the frontend would
  // make it unreadable to anyone running PCSX2 any other way.
  if (known) return { ...known(ctx), emulator: component }

  /**
   * A libretro core, inside the RetroArch RetroDECK bundles.
   *
   * Its config is the one RetroDECK wrote during setup, which is why this is
   * not simply `<saves>/<system>`: RetroDECK turns *sort by content directory*
   * on and leaves *sort by core* off, so the folder is named after the
   * directory the ROM sits in. That equals the system for an ordinary loose
   * ROM and does not for a multi-file game installed into a folder of its own —
   * the difference between finding a save and creating an empty directory
   * beside it.
   */
  const config = readLibretroConfig(
    ctx.env,
    ctx.configDir ? [joinPath(ctx.configDir, 'retroarch', 'retroarch.cfg')] : [],
    ctx.home
  )
  /**
   * The core RetroDECK's own command names, and only that.
   *
   * Which core runs is RetroDECK's to decide — it is handed the system, not a
   * core — so unlike RetroArch there is nothing here RomMix chose and can
   * simply report. Where the command cannot be read the tag stays the frontend:
   * `coreForSystem` would answer with the core RomMix *would* have picked,
   * which is a confident guess at somebody else's decision, and a save tagged
   * with the wrong core is worse than one tagged with no core at all.
   *
   * It still stands in for the path, where a wrong core costs nothing: sorting
   * by core is off in the config RetroDECK ships, so it only names a directory
   * that is searched and never written.
   */
  const named = coreForCommand(ctx, commandLabel(ctx))
  const paths: SavePaths = {
    ...libretroSavePaths(ctx, config, named ?? coreForSystem(ctx.system), {
      saves: ctx.paths.saves,
      states: ctx.paths.states
    }),
    emulator: named ?? LIBRETRO_TAG
  }
  return named ? { ...paths, ...coreUnit(ctx, named, paths.saves) } : paths
}

/**
 * The cores that file a game's saves in a folder every game shares, keyed by
 * something only the disc knows.
 *
 * Flycast with per-game VMUs writes `<product>.A1.bin` into the core's save
 * folder; PPSSPP keeps a memory stick there, `PSP/SAVEDATA` and one folder per
 * save. Both are the standalone's formats, so the same rules and the same tag
 * serve either way of running them. Without a key the core's ordinary layout
 * stands, with the reason nothing in it is this game's.
 */
function coreUnit(
  ctx: SaveContext,
  core: string,
  saves: SaveLocation | null
): Pick<SavePaths, 'saves' | 'unsyncableReason'> | null {
  if (!saves || (core !== 'flycast' && core !== 'ppsspp')) return null
  const key = saveKey(ctx)
  const rule = key ? (core === 'flycast' ? dreamcastUnit(key) : pspUnit(key, ctx.env)) : null
  if (!rule) return { saves, unsyncableReason: 'saves.noSaveTarget' }
  const dir = core === 'flycast' ? saves.dir : joinPath(saves.dir, 'PSP', 'SAVEDATA')
  return { saves: unit(dir, guarded(rule, 'retroarch')) }
}
