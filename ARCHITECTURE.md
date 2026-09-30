# Per-game save units

This fork (`igno2k/rommix`, from `leclercb/rommix` 0.20.0) syncs the saves of
the emulators that write every game into one shared folder: PCSX2's folder
memory card, Dolphin's GCI folder, PPSSPP's `SAVEDATA`, and Flycast's per-game
VMU. Upstream skips all four as "shared". This note says where the code for
that lives, what goes over the wire, and what a pull may and may not touch.

## The fork

- `package.json` `repository` names the fork. The updater's API calls and
  releases page, the release notes, the landing page and the demo all derive
  from it (`scripts/repository.mjs`). It reaches the main process as
  `UPDATE_REPOSITORY`, a `define` in `electron.vite.config.ts`. A fork build
  updates from the fork's own releases. A build with no stamp does not check
  for updates at all (`updateRepository` in `src/main/update.ts`).
- The rest of upstream's architecture is unchanged. `CONTRIBUTING.md` still
  describes it.

## Module boundaries

The dependency rule is upstream's: `src/config/` is pure, loaded by the
renderer too, and imports no `node:` module. `src/main/` does the I/O. No code
outside `src/config/` names an emulator.

| Layer          | File                                                 | What it holds                                                                             |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Port (domain)  | `src/config/emulators/savepaths.ts`                  | `SaveMatch` `'unit'`, `SaveUnit`, `SaveLocation.unit`, `SaveContext.saveTarget`, `unit()` |
| Rules (domain) | `src/config/emulators/units/{keys,ps2,gc,psp,dc}.ts` | Key readers and normalisation. One `SaveUnit` factory per system.                         |
| Rules (domain) | `src/config/emulators/units/gamedb.ts`               | Names and `memcardFilters` read out of PCSX2's `GameIndex.yaml`, once per environment     |
| Wiring         | `src/config/emulators/retrodeck/saves.ts`            | Which folder and which rule per RetroDECK component, and the reason when none applies     |
| Setup rules    | `src/config/emulators/retrodeck/savesetup.ts`        | The save-relevant settings, as data. Pure reads and line-level edits.                     |
| Adapter        | `src/main/saveunits.ts`                              | `findUnit`, `restoreUnit`, `removeUnit`: the disk half of a unit                          |
| Adapter        | `src/main/zip.ts`                                    | `zipMembers`, `zipRoots`, `zipContentHash`, `membersContentHash`                          |
| Application    | `src/main/saves.ts`                                  | `SaveSync`, routing `match: 'unit'` through find, compare, pull, push and delete          |
| Adapter        | `src/main/savesetup.ts`, `ipc/system.ts`             | Checking, the `save-setup.json` report, a confirmed fix                                   |
| RomM port      | `src/shared/types/romm.ts`, `schema/romm-5.3.1.json` | `save_target` and `save_target_layout` on `RommRom`                                       |

## The key

Every unit is named by a key the game itself carries. It comes from RomM 5.3's
`save_target`, which the scan reads out of the disc. Argosy trusts the same
field. GameCube is the exception: the disc id is read from the image header
first (ISO, RVZ, WIA or CISO, `units/keys.ts`, after Argosy's
`GameCubeHeaderParser.kt`), and `save_target` is only the fallback. Without a
key nothing on the shared folder is claimed, and the buttons say why
(`saves.noSaveTarget`).

## Formats (Argosy's, so the two clients read each other's saves)

| System    | Folder (RetroDECK 0.10.9b)                                                                                                               | The game's entries                                                                                                                                                       | On the wire                                                     | Argosy reference                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------- |
| PS2       | `saves/ps2/pcsx2/memcards/<Slot1_Filename>`, a folder card with `_pcsx2_superblock`                                                      | Folders whose normalised name starts with the serial stem (`BASLUS20152…`), plus those PCSX2's GameDB filters show the game (below). Never `*DATA-SYSTEM` or `*WNETCNF`. | Zip, each folder a root, without PCSX2's `_pcsx2_index` (below) | `PlatformSaveHandlerRegistry.kt`, `SaveArchiver.kt` |
| GameCube  | `saves/gc/dolphin/{US,EU,JP}/Card A` (RetroDECK links these to Dolphin's `GC/{USA,EUR,JAP}`). Needs `SlotA = 8` and no `GCIFolderAPath`. | `.gci` files whose header names the disc id. The name stands in only where the header cannot be read. `.deleted` is skipped.                                             | Zip, each file a root                                           | `GciSaveHandler.kt`, `GameCubeHeaderParser.kt`      |
| PSP       | `saves/PSP/PPSSPP-SA` (RetroDECK links PPSSPP's `PSP/SAVEDATA` there), or `<core save dir>/PSP/SAVEDATA` for the libretro core           | Folders starting with the disc id, minus installed game data (a readable PARAM.SFO without `SAVEDATA_PARAMS` or `SAVEDATA_FILE_LIST`)                                    | Zip, each folder a root                                         | `PrefixBundleFolderHandler.kt`                      |
| Dreamcast | The Flycast core's save folder (`saves/dreamcast`), with `reicast_per_content_vmus = "VMU A1"`                                           | `<product>.A1.bin`, with ` /\:*?\|<>` in the product turned into `_` (Flycast's `getVmuPath`)                                                                            | The file as it is                                               | `DreamcastSaveHandler.kt`                           |

The upload is named `<ROM name>.zip`, or `<ROM name>.<ext>` for the VMU. It
goes to slot `autosave` (RomM re-stamps the name, so only the slot identifies
it). RomM's `content_hash` for an archive is the md5 of its entries' names and
md5s (`hash_zip_contents`), not the md5 of the archive's bytes. RomMix compares
and verifies units by that value, so a save zipped by Argosy and the same save
on this disk are recognised as one.

## PS2: the folders PCSX2 shows a game

With `McdFolderAutoManage` on, PCSX2 does not show a game the whole card. It
indexes only the folders whose name contains a part of a filter
(`FilterMatches`, `SIO/Memcard/MemoryCardFolder.cpp`, PCSX2 v2.6.3). The filter
is the game's `memcardFilters` from its game database, joined with `/`, or the
disc serial where the entry has none (`VMManager.cpp`, `FileMcd_Reopen`).
`AddFolder` puts `DATA-SYSTEM/BWNETCNF/` in front of it, so every game also sees
the console's system and network folders. The match is a plain substring of
the name as written, over folders only. Files at the card's root are skipped.

RomMix reads the same database. RetroDECK's `pcsx2/component_recipe.json`
copies the AppImage's `usr/bin` to the component's `bin`. The AppImage keeps
`resources/` beside the executable, and PCSX2 loads `GameIndex.yaml` from there
(`EmuFolders::Resources`, `GameDatabase.cpp`). So the file is
`<RetroDECK install>/files/retrodeck/components/pcsx2/bin/resources/GameIndex.yaml`,
where the install is what `flatpak info --show-location net.retrodeck.retrodeck`
names. It is read with a line scanner for the fields it needs (`units/gamedb.ts`), not
a YAML library, and parsed once per `SaveEnvironment`, which in the app is once
per process.

- A game owns its serial folders as before, plus every folder a filter matches.
  The filters add to the serial rather than replace it, as they would in PCSX2:
  some entries (multi-disc Xenosaga, for one) list only their sister serials,
  and a sync must not drop the game's own folders.
- `*DATA-SYSTEM` and `*WNETCNF` are never owned, even where a filter names
  them, as Monster Hunter's names `BWNETCNF`. They are also on the hands-off
  list, so an archive carrying one is refused whole.
- A folder owned only through a filter belongs to another game too
  (`SaveUnit.shares`). That game's sync keeps it. A push carries it, so the
  archive and its content hash are the same as before. A pull writes it only
  where nothing is there yet. It never replaces, re-dates or removes one that
  is there, and deleting this game's saves leaves it. The unit's age
  (`findUnit`'s `newest`, which the pull compares with the server's copy) is
  taken from the game's own folders alone, so playing the other game does not
  make this one read as newer than the server.
- RomM can file two ROMs under one serial. Half-Life and Half-Life: Blue
  Shift are both `BASLUS-20066`, because Blue Shift shipped on the Half-Life
  disc. Only one of them may keep the serial's folders.
  - A ROM whose name is the database's name for the serial owns the folders.
    The ROM's file name is compared without region tags, a leading or trailing
    "The" and punctuation (`titleKey`), against the entry's `name`, `name-en`
    and `name-sort`.
  - Any other ROM needs the count. Its unit says so with
    `SaveUnit.sharingKey`, the bare serial without the card's region prefix,
    so `BASLUS-20066` and `SLUS-20066` are one key. `SaveSync` then walks the
    platform's ROMs, without their files, since RomM cannot filter its listing
    by `save_target` but returns the field. It counts them by that key and asks
    the descriptor again (`SaveContext.saveTarget.romsSharing`). The walk is
    kept for the session. A walk that failed stands for `SAVE_KEY_RETRY_MS`,
    so an offline machine does not wait on the server at every save action.
    No other system's rule asks for it.
  - Only ROM under the serial: it owns the folders, whatever it is called.
    Redump's `Ratchet & Clank - Going Commando` is the only ROM under its
    serial and so owns it, though the database calls it `Ratchet & Clank 2`.
  - More than one: every ROM but the database's name holds them as `shares`.
    It writes them where they are missing and never replaces or deletes them.
    So does every ROM of a serial the database has no name for.
  - Count unknown, because the server could not be listed: the ROM owns the
    folders, as before, and the log says so.
- Where the database cannot be read, because the install location is unknown,
  the file is missing, or it holds no entries, the unit is the serial alone and
  owned as before. `SaveUnit.note` says why, and `SaveSync` logs it as a
  warning, as it does the two cases above. Such a device refuses an archive
  that carries a shared folder, since that root is not one it owns. That is
  safe: nothing is written, and the refusal is logged.

### PCSX2's own files inside a save folder

A folder card keeps `_pcsx2_index` in every save folder: the order and dates of
the folder's files (`FolderMemoryCard`). It is not the save. A raw card has no
such file, and PCSX2 orders a folder without one by itself (`GetOrderedFiles`).
Argosy zips a save folder as it finds it, so its archives carry the index when
the card had one. The Argosy uploads checked, made on Android, carry none.
Romp, Ludo and the save importer leave it out.

RomMix accepts both and sends without (`SaveUnit.ignoresInside`, `PS2_FOLDER_FILES`):

- A push leaves `_pcsx2_index` out of the archive and out of the content hash.
  The same save then hashes alike on a folder card, a raw card and in every
  client. For the three real saves in the interop check, an export of the
  untouched card equals the `content_hash` RomM recorded for Argosy's upload.
- A pull writes the index an archive carries, because it describes the files
  it came with, and some games depend on their order. Where the archive has
  none it keeps this device's own, copied back into the replaced folder. Where
  neither has one, PCSX2 does without. A copy that fails is logged, and never
  fails the pull.
- The index does not count towards the unit's age.

`_pcsx2_meta_directory` and the `_pcsx2_meta` folder are part of the save. They
hold the raw 0x200-byte directory entry of a folder or file whose PS2 name,
mode or attributes the host file system cannot express (`WriteMetadata`). A
card loaded without them shows cleaned names and default modes. They are
carried, hashed and written like any other file of the save.

## Tags

A unit is uploaded under the emulator that wrote it: `pcsx2`, `dolphin`,
`ppsspp`, or the core id `flycast` / `ppsspp` under libretro. A pull accepts
only a matching tag, plus the tags Argosy's Android forks upload the same
files under: `armsx2`, `nethersx2` and `aethersx2` for PS2, `ppsspp_gold` for
PSP (`SaveUnit.alsoAccepts`).

## What a pull may do

1. Only the newest copy in the `autosave` slot comes down. A copy with no slot
   is listed and left for a person to decide about.
2. Nothing is written into a unit while RetroDECK or the unit's emulator is
   running (its command line carries RetroDECK's flatpak id, or the
   emulator's name). A pull or delete asked for on the game screen says so; the
   automatic one before a launch skips the unit and logs it.
3. The copy is downloaded to a temporary file and checked against RomM's
   content hash, or its byte md5 or length, before anything else happens.
4. Its roots are read from the archive's directory before it is unpacked. A
   root the rule keeps its hands off (`_pcsx2_superblock`, the PS2 system and
   network folders) refuses the whole
   archive, and so does any root whose name rules it out (`SaveUnit.mayOwn`):
   a PSP folder without the disc-id prefix, a non-`.gci` file, or a GCI whose
   Dolphin-style `<maker>-<code>-` name names another game. A GCI whose name
   says nothing, such as `zelda.gci`, goes on to the header check. The one shape let past is a single folder, which may be a whole
   card another client zipped. An archive that declares more than
   `SAVE_ARCHIVE_MAX_BYTES` unpacked is refused as well.
5. It is unpacked beside the shared folder, on the same filesystem, never
   inside it. Every root is then judged again by what it holds
   (`SaveUnit.owns` reading the GCI header or PARAM.SFO of the unpacked copy).
   A single folder is read one level down, and only the game's entries in it
   are taken.
6. Every member about to be replaced or removed is copied into
   `<RomMix>/saves/<romId>/<member>.<n>` first, with the usual rotation. If a
   copy cannot be taken, nothing is changed.
7. The members are swapped in by renames, all or nothing: if any move fails,
   every member already swapped is put back before the error is raised. If one
   cannot be put back, the displaced copies are left beside the folder and
   named in the log, rather than cleaned away. A member that exists here but
   not in the archive is removed, after its copy, unless another game owns it
   too (`SaveUnit.shares`). That is the one deletion a pull makes, and it is
   logged by name.
8. Nothing else in the folder is read for an upload or written by a pull. The
   tests hash the whole folder minus the game's members before and after
   (`saveunits.test.ts`, `savesync-units.test.ts`).

Deleting a unit "on this device" removes the game's members, each copied aside
first, and nothing else, under the same running-emulator guard. Members another
game owns too are left.

## The first Dreamcast launch

With per-game VMUs on (`reicast_per_content_vmus` is `VMU A1` or `All VMUs`),
Flycast opens `<product>.A1.bin` in the core's save folder. Where that is
missing it loads a file named after the content, writes the product-named file
from it and deletes the old one (`getVmuPath` in `oslib.cpp`, `maple_devs.cpp`).
A game with neither starts on an empty VMU, and its saves on the shared
`<system dir>/dc/vmu_save_A1.bin` are out of its sight.

So after the pull before a launch, RomMix copies the shared VMU to
`<save folder>/<content name>.A1.bin` when neither that file nor
`<product>.A1.bin` exists. Flycast then takes it over through its own path.
It does so only where automatic pulls are on, and only after a pull that
listed the server and brought down everything it meant to. A pull that threw,
or lost a copy on the way, may have left the game's own VMU on the server,
and a seed in its place would be what the next push sends over it.

A seeded VMU is a copy of the whole shared card, every game's saves on it
included. Once Flycast has taken it over it is this game's unit: it goes to
RomM under this game with the other games' saves still on it, and from then
on it and the shared card change apart.

- The rule is `dreamcastSeed` (`units/dc.ts`), with Flycast's content name
  (`flycastContentName`: the file name cut to Flycast's buffer, minus its last
  extension). RetroDECK's wiring (`flycastSeed` in `retrodeck/saves.ts`)
  supplies the option, the save folder the layout above resolves
  (`savefile_directory/<ROM folder>` with sorting by content), and the system
  folder (`system_directory`, or the ROM's folder where it is empty).
- The option comes from the first options file RetroArch would read
  (`flycastOptionFiles` in `retrodeck/flycast.ts`): the game's own `.opt`, the
  folder's, then with `global_core_options` off `Flycast.opt` (or the global
  file where it is not there yet), and with it on the global
  `retroarch-core-options.cfg` alone. The save-setup rule
  `flycast.perContentVmuOverride` checks the same file: `Flycast.opt`, or the
  global file with `global_core_options` on.
- It reaches the main process as `SavePaths.seed`. `plantSeed`
  (`src/main/saveunits.ts`) writes the copy beside the target and links it into
  place, so nothing is ever overwritten. `SaveSync.seed` runs it with the
  pull's result, and the launcher calls that after the pull; a failure is
  logged and the game starts.
- No copy is made, with the reason logged, for a file Flycast runs as a NAOMI
  or Atomiswave board (`.lst`, `.bin`, `.dat`, `.zip`, `.7z`), for any system
  but `dreamcast`, for a game RomM sent no `save_target` for, or for a name
  Flycast cuts inside a character. None is made where the shared VMU is
  missing. Only port A1 is seeded.

## Save setup

RomMix is the single writer of the settings that decide where and in what
shape a save is written. These are PCSX2's folder-card management and the card
in slot 1, Dolphin's GCI folder, Flycast's per-game VMU (including overrides),
the RetroArch save layout, DuckStation's per-title card, and the command ES-DE
runs each system with (psx on SwanStation). The rules are in
`retrodeck/savesetup.ts`. The check runs at start-up and in the pre-flight
check, and writes `<RomMix>/config/save-setup.json`, whose shape is
`SaveSetupReport` in `src/shared/types/system.ts`. bazzite-maint reads that
file and re-reads each named file itself, instead of keeping its own table.

Each item says enough to be checked again without RomMix's code. Besides
`id`, `file`, `format`, `section`, `key`, `wanted`, `found`, `status`, `fix`
and `reason` it carries three fields, added within `schema: 1` (a reader of
the older shape ignores them):

| Field          | Values                                                              | Meaning                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`        | `"value"` \| `"folder-card"` \| `"system-label"` \| `"game-labels"` | `value`: `key` in `file` against `wanted`, for every plain setting. `folder-card`: whether the PCSX2 card `key` names is a folder card. `system-label`: the command ES-DE runs the system with. `game-labels`: every per-game override in the gamelist.                                                                                 |
| `absentIsFine` | `true` \| `false`                                                   | A missing key or file counts as `wanted`.                                                                                                                                                                                                                                                                                               |
| `compare`      | `"normalized"` \| `"exact"`                                         | `normalized` (every `value` item): `normalizeSetting` — trimmed, surrounding quotes dropped, case ignored, `1`/`yes`/`true` as `true`, `0`/`no`/`false` as `false`; INI sections and keys matched without case, RetroArch keys exactly. `exact` (the three derived checks): the strings as written, which is how ES-DE matches a label. |

A fix only happens when someone confirms it in Settings. It is refused while a
game or anything in RetroDECK's sandbox runs, through a link, and into a config
file the emulator has not written yet. The file is copied into
`<RomMix>/config/emulator-backups/` first, then one line is edited and the file
renamed into place. A value that is already right writes nothing. A raw PS2
card, DuckStation's card type, a moved GCI folder and a per-game override are
reported, never changed: each moves saves, which is a person's migration to
run. The ES-DE rows only exist for systems whose save shape depends on the
emulator, and each names RetroDECK's own first command
(`retrodeck/fixtures/es_systems.xml`), so the check never moves a system off
RetroDECK's default.

## Assumed, not verified on a device

- Dolphin files a Korean disc's cards under `JAP`.
- The PPSSPP libretro core keeps its memory stick in the core's save folder
  (`saves/psp/PSP/SAVEDATA` under RetroDECK). The standalone's
  `saves/PSP/PPSSPP-SA` is taken from RetroDECK's `component_prepare.sh`.
- The fork's release assets carry the GitHub `digest` the updater requires.
- With `global_core_options` off and no `Flycast.opt` yet, RetroArch takes
  Flycast's options from the global file. The RomM `save_target` of a
  Dreamcast game is the product number Flycast reads.
