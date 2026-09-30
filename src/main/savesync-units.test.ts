import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
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
import type { EmulatorState } from '@config/emulators'
import {
  DC_OWNED,
  GCI_FOLDER,
  GC_OWNED,
  PS2_CARD,
  PS2_OWNED,
  PSP_OWNED,
  SAVEDATA,
  VMU_DIR,
  gameCubeIso,
  gci,
  paramSfo,
  type FixtureTree
} from '@config/emulators/units/fixtures.ts'
import type { RommRom, RommSave } from '@shared/types'
import type { RommClient } from './romm/index.ts'
import { SaveSync, type SaveTarget } from './saves.ts'
import { Store } from './store.ts'
import { zipContentHash, zipDirectory, zipRoots } from './zip.ts'

/**
 * Save sync through RetroDECK's shared cards, end to end against a fake RomM.
 *
 * What `saveunits.test.ts` proves of the swap on its own is proved here of the
 * whole path a launch takes: the descriptor resolves the unit from RomM's key,
 * the push sends the game's members under the name and slot Argosy uses, and
 * the pull brings the slot down over those members and nothing else — asserted
 * as the hash of every other file on the card, before and after.
 */

const scratches: string[] = []
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rommix-savesync-units-test-'))
  scratches.push(dir)
  return dir
}

function plant(root: string, tree: FixtureTree): void {
  mkdirSync(root, { recursive: true })
  for (const [path, contents] of Object.entries(tree)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), Buffer.from(contents, 'latin1'))
  }
}

function hashes(root: string, skip: readonly string[] = []): Record<string, string> {
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

const ES_SYSTEMS =
  'files/retrodeck/components/es-de/share/es-de/resources/systems/linux/es_systems.xml'

interface Uploaded {
  fileName: string
  emulator: string | null
  slot: string | null
  bytes: Buffer
}

/** A RetroDECK install with one game, and a RomM that holds `saves` for it. */
function retroDeck(options: {
  system: string
  romFile: string
  romBytes?: string
  saveTarget?: string
  saves?: RommSave[]
  /** What a download hands back: the game's entries, zipped as an upload is. */
  remote?: FixtureTree
  /** What a download hands back when it is one file. */
  remoteFile?: string
}): {
  sync: SaveSync
  target: SaveTarget
  saves: string
  backups: string
  uploaded: Uploaded[]
} {
  const home = scratch()
  const rd = join(home, 'retrodeck')
  const install = join(home, 'install')
  mkdirSync(join(install, ES_SYSTEMS, '..'), { recursive: true })
  writeFileSync(
    join(install, ES_SYSTEMS),
    '<systemList><system><name>dreamcast</name>' +
      '<command label="Flycast">%EMULATOR_RETROARCH% -L %CORE_RETROARCH%/flycast_libretro.so %ROM%</command>' +
      '</system></systemList>'
  )
  const romDir = join(rd, 'roms', options.system)
  mkdirSync(romDir, { recursive: true })
  const romPath = join(romDir, options.romFile)
  writeFileSync(romPath, Buffer.from(options.romBytes ?? 'rom', 'latin1'))
  const config = join(home, 'config')
  mkdirSync(join(config, 'retroarch'), { recursive: true })
  writeFileSync(
    join(config, 'retroarch', 'retroarch.cfg'),
    [
      `savefile_directory = "${rd}/saves"`,
      `savestate_directory = "${rd}/states"`,
      'sort_savefiles_by_content_enable = "true"',
      'sort_savestates_by_content_enable = "true"'
    ].join('\n')
  )

  const uploaded: Uploaded[] = []
  const client = {
    saves: async () => options.saves ?? [],
    states: async () => [],
    devices: async () => [],
    downloadSave: async (_id: number, to: string) => {
      if (options.remoteFile !== undefined) {
        writeFileSync(to, Buffer.from(options.remoteFile, 'latin1'))
        return
      }
      const staging = scratch()
      plant(staging, options.remote ?? {})
      await zipDirectory(staging, to)
    },
    downloadState: async () => {
      throw new Error('no states here')
    },
    uploadSave: async (
      _romId: number,
      filePath: string,
      fileName: string,
      emulator: string | null,
      slot: string | null
    ) => {
      uploaded.push({ fileName, emulator, slot, bytes: readFileSync(filePath) })
      return remoteSave({ file_name: fileName, updated_at: '2026-09-02T10:00:00.000Z' })
    }
  } as unknown as RommClient

  const emulator = {
    id: 'retrodeck',
    name: 'RetroDECK',
    available: true,
    install: { location: install },
    configDir: config,
    dataDir: null,
    unavailableReason: null,
    paths: {
      home: rd,
      roms: join(rd, 'roms'),
      saves: join(rd, 'saves'),
      states: join(rd, 'states'),
      bios: join(rd, 'bios')
    }
  } as unknown as EmulatorState

  const stem = options.romFile.replace(/\.[^.]+$/, '')
  const rom = {
    id: 42,
    name: stem,
    fs_name: options.romFile,
    fs_name_no_ext: stem,
    platform_slug: options.system,
    platform_fs_slug: options.system,
    save_target: options.saveTarget ?? null,
    save_target_layout: null
  } as RommRom

  const backups = join(home, 'save-copies')
  return {
    sync: new SaveSync(new Store(join(home, 'rommix')), client, backups),
    target: { rom, emulator, system: options.system, romPath },
    saves: join(rd, 'saves'),
    backups,
    uploaded
  }
}

function remoteSave(fields: Partial<RommSave> = {}): RommSave {
  return {
    id: 1,
    rom_id: 42,
    file_name: 'Game [2026-09-01 12-00-00].zip',
    file_size_bytes: 0,
    emulator: 'pcsx2',
    slot: 'autosave',
    updated_at: '2026-09-01T12:00:00.000Z',
    origin_device_id: null,
    content_hash: null,
    ...fields
  } as RommSave
}

/** The roots of an uploaded archive. */
async function rootsOf(bytes: Buffer): Promise<string[]> {
  const path = join(scratch(), 'up.zip')
  writeFileSync(path, bytes)
  return (await zipRoots(path)).map((root) => root.name).sort()
}

const OLD = new Date('2026-08-01T00:00:00Z')

/** What RomM records as `content_hash` for these files, zipped. */
async function rommHashOf(tree: FixtureTree): Promise<string> {
  const root = scratch()
  plant(join(root, 'files'), tree)
  await zipDirectory(join(root, 'files'), join(root, 'up.zip'))
  return zipContentHash(join(root, 'up.zip'))
}

/** Date every file under `root` well before any server copy. */
function age(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) utimesSync(join(entry.parentPath, entry.name), OLD, OLD)
  }
}

// ---------------------------------------------------------------------------

const PS2_REMOTE: FixtureTree = {
  'BASLUS-20152AC04/icon.sys': 'icon of the first game',
  'BASLUS-20152AC04/BASLUS-20152AC04': 'progress made on the other device',
  'BASLUS-20152SYS/icon.sys': 'system icon of the first game',
  'BASLUS-20152SYS/settings': 'settings changed on the other device'
}

describe('PCSX2 folder card', () => {
  function ps2(options: { saves?: RommSave[]; remote?: FixtureTree } = {}) {
    const rig = retroDeck({
      system: 'ps2',
      romFile: 'Jak and Daxter (USA).chd',
      saveTarget: 'SLUS-20152',
      ...options
    })
    const card = join(rig.saves, 'ps2', 'pcsx2', 'memcards', 'Mcd001.ps2')
    plant(card, PS2_CARD)
    age(card)
    return { ...rig, card }
  }

  test('a push sends the game’s folders as one zip, under the ROM’s name and the shared slot', async () => {
    const { sync, target, uploaded } = ps2()

    const result = await sync.pushNow(target)

    assert.equal(result.saves, 1)
    assert.equal(uploaded.length, 1)
    assert.equal(uploaded[0].fileName, 'Jak and Daxter (USA).zip')
    assert.equal(uploaded[0].slot, 'autosave')
    assert.equal(uploaded[0].emulator, 'pcsx2')
    assert.deepEqual(await rootsOf(uploaded[0].bytes), [...PS2_OWNED].sort())
  })

  test('a pull replaces the game’s folders, and every other byte on the card stays', async () => {
    const { sync, target, card, backups } = ps2({ saves: [remoteSave()], remote: PS2_REMOTE })
    const others = hashes(card, PS2_OWNED)

    const result = await sync.pullNow(target)

    assert.deepEqual([result.saves, result.failed], [1, 0])
    assert.deepEqual(hashes(card, PS2_OWNED), others)
    assert.equal(
      readFileSync(join(card, 'BASLUS-20152AC04', 'BASLUS-20152AC04'), 'utf8'),
      'progress made on the other device'
    )
    assert.ok(existsSync(join(backups, '42', 'BASLUS-20152AC04.1')))
    assert.ok(existsSync(join(backups, '42', 'BASLUS-20152SYS.1')))
  })

  test('once pulled, the unit reads as in sync and a second pull fetches nothing', async () => {
    const { sync, target } = ps2({ saves: [remoteSave()], remote: PS2_REMOTE })
    await sync.pullNow(target)

    const again = await sync.pullNow(target)
    assert.equal(again.saves, 0)
    const [row] = await sync.listAssets(42, target)
    assert.equal(row.sync, 'synced')
    assert.equal(row.fileName, 'Jak and Daxter (USA).zip')
  })

  test('a save one of Android’s PCSX2 forks sent is taken, one another emulator sent is not', async () => {
    const forked = ps2({ saves: [remoteSave({ emulator: 'armsx2' })], remote: PS2_REMOTE })
    assert.equal((await forked.sync.pullNow(forked.target)).saves, 1)

    const other = ps2({ saves: [remoteSave({ emulator: 'duckstation' })], remote: PS2_REMOTE })
    const before = hashes(other.card)
    assert.equal((await other.sync.pullNow(other.target)).saves, 0)
    assert.deepEqual(hashes(other.card), before)
  })

  test('a copy with no slot is listed, not unpacked over the game’s folders', async () => {
    const { sync, target, card } = ps2({ saves: [remoteSave({ slot: null })], remote: PS2_REMOTE })
    const before = hashes(card)
    assert.equal((await sync.pullNow(target)).saves, 0)
    assert.deepEqual(hashes(card), before)
  })

  test('a copy on RomM carrying another game’s folder is refused, and the card is untouched', async () => {
    const { sync, target, card } = ps2({
      saves: [remoteSave()],
      remote: { ...PS2_REMOTE, 'BASLUS-21693XX/BASLUS-21693XX': 'not ours' }
    })
    const before = hashes(card)

    const result = await sync.pullNow(target)

    assert.deepEqual([result.saves, result.failed], [0, 1])
    assert.deepEqual(hashes(card), before)
  })

  test('a copy RomM hashed by its contents is checked against them before anything moves', async () => {
    const good = ps2({
      saves: [remoteSave({ content_hash: await rommHashOf(PS2_REMOTE) })],
      remote: PS2_REMOTE
    })
    assert.deepEqual(
      [(await good.sync.pullNow(good.target)).saves, (await good.sync.pullNow(good.target)).failed],
      [1, 0]
    )

    const bad = ps2({ saves: [remoteSave({ content_hash: 'f'.repeat(32) })], remote: PS2_REMOTE })
    const before = hashes(bad.card)
    assert.equal((await bad.sync.pullNow(bad.target)).failed, 1)
    assert.deepEqual(hashes(bad.card), before)
  })

  test('the same save here is recognised by its contents, whatever the clocks say', async () => {
    // RomM's copy is the card's own two folders, as another device uploaded
    // them: newer by the clock, the same by the hash.
    const own = Object.fromEntries(
      Object.entries(PS2_CARD).filter(([path]) =>
        PS2_OWNED.some((member) => path.startsWith(`${member}/`))
      )
    )
    const { sync, target, backups } = ps2({
      saves: [remoteSave({ content_hash: await rommHashOf(own) })],
      remote: own
    })

    assert.equal((await sync.pullNow(target)).saves, 0)
    assert.equal(existsSync(backups), false)
    const [row] = await sync.listAssets(42, target)
    assert.equal(row.sync, 'synced')
  })

  test('the Saves tab lists the unit as one row, sized by its members, in the card', async () => {
    const { sync, target, card } = ps2()
    const [row] = await sync.listAssets(42, target)

    assert.equal(row.fileName, 'Jak and Daxter (USA).zip')
    assert.equal(row.slot, 'autosave')
    const members = Object.entries(PS2_CARD).filter(([path]) =>
      PS2_OWNED.some((member) => path.startsWith(`${member}/`))
    )
    assert.equal(
      row.sizeBytes,
      members.reduce((sum, [, contents]) => sum + contents.length, 0)
    )
    assert.equal(join(row.localPath ?? '', '..'), card)
  })

  test('deleting it here removes the game’s folders and nothing else of the card', async () => {
    const { sync, target, card, backups } = ps2()
    const others = hashes(card, PS2_OWNED)

    await sync.deleteAsset(42, 'save', null, 'Jak and Daxter (USA).zip', 'local', target)

    assert.deepEqual(hashes(card), others)
    assert.ok(existsSync(join(backups, '42', 'BASLUS-20152AC04.1')))
  })

  test('without RomM’s key nothing on the card is claimed, and the reason is given', async () => {
    const rig = retroDeck({ system: 'ps2', romFile: 'Jak.chd' })
    plant(join(rig.saves, 'ps2', 'pcsx2', 'memcards', 'Mcd001.ps2'), PS2_CARD)
    const result = await rig.sync.pushNow(rig.target)
    assert.equal(result.saves, 0)
    assert.match(result.skippedReason ?? '', /RomM 5\.3/)
  })
})

describe('Dolphin GCI folder', () => {
  test('a round trip by the disc id in the image, the other game’s .gci untouched', async () => {
    const remote: FixtureTree = {
      '01-GZLE-gczelda2.gci': gci('GZLE01', 'gczelda2', 'further on the other device'),
      '01-GZLE-gczelda2b.gci': gci('GZLE01', 'gczelda2b', 'second quest, also further')
    }
    const rig = retroDeck({
      system: 'gc',
      romFile: 'Zelda.iso',
      romBytes: gameCubeIso('GZLE01'),
      // Later than the push below stamps the local files with, as a save made
      // on the other device after this one's upload is.
      saves: [remoteSave({ emulator: 'dolphin', updated_at: '2026-09-03T08:00:00.000Z' })],
      remote
    })
    const cardA = join(rig.saves, 'gc', 'dolphin', 'US', 'Card A')
    plant(cardA, GCI_FOLDER)
    age(cardA)
    const others = hashes(cardA, GC_OWNED)

    await rig.sync.pushNow(rig.target)
    assert.deepEqual(await rootsOf(rig.uploaded[0].bytes), [...GC_OWNED].sort())

    const pulled = await rig.sync.pullNow(rig.target)
    assert.equal(pulled.saves, 1)
    assert.deepEqual(hashes(cardA, GC_OWNED), others)
    assert.equal(
      readFileSync(join(cardA, '01-GZLE-gczelda2.gci'), 'latin1'),
      remote['01-GZLE-gczelda2.gci']
    )
  })
})

describe('PPSSPP SAVEDATA', () => {
  test('a pull replaces the disc id’s save folders and leaves its installed data and the other game', async () => {
    const remote: FixtureTree = {
      'ULUS10064DATA00/PARAM.SFO': paramSfo(['SAVEDATA_PARAMS']),
      'ULUS10064DATA00/DATA.BIN': 'first slot, played elsewhere',
      'ULUS10064SETTINGS/PARAM.SFO': paramSfo(['SAVEDATA_PARAMS']),
      'ULUS10064SETTINGS/SETTINGS.BIN': 'options, changed'
    }
    const rig = retroDeck({
      system: 'psp',
      romFile: 'Daxter.iso',
      saveTarget: 'ULUS10064',
      saves: [remoteSave({ emulator: 'ppsspp_gold' })],
      remote
    })
    const savedata = join(rig.saves, 'PSP', 'PPSSPP-SA')
    plant(savedata, SAVEDATA)
    age(savedata)
    const others = hashes(savedata, PSP_OWNED)

    const pulled = await rig.sync.pullNow(rig.target)

    assert.equal(pulled.saves, 1)
    assert.deepEqual(hashes(savedata, PSP_OWNED), others)
    assert.equal(
      readFileSync(join(savedata, 'ULUS10064DATA00', 'DATA.BIN'), 'utf8'),
      remote['ULUS10064DATA00/DATA.BIN']
    )
    // The slot the other device no longer has goes, and is kept among the copies.
    assert.equal(existsSync(join(savedata, 'ULUS10064DATA01')), false)
    assert.ok(existsSync(join(rig.backups, '42', 'ULUS10064DATA01.1')))
  })
})

describe('Flycast per-game VMU', () => {
  test('a push sends the VMU as it is, named after the ROM, in the shared slot', async () => {
    const rig = retroDeck({
      system: 'dreamcast',
      romFile: 'Crazy Taxi (USA).chd',
      saveTarget: 'MK-51035'
    })
    plant(join(rig.saves, 'dreamcast'), VMU_DIR)

    await rig.sync.pushNow(rig.target)

    const sent = rig.uploaded.filter((file) => file.slot === 'autosave')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].fileName, 'Crazy Taxi (USA).bin')
    assert.equal(sent[0].emulator, 'flycast')
    assert.equal(sent[0].bytes.toString('latin1'), VMU_DIR['MK-51035.A1.bin'])
  })

  test('a pull writes the product-named VMU Flycast opens, and no other file changes', async () => {
    const rig = retroDeck({
      system: 'dreamcast',
      romFile: 'Crazy Taxi (USA).chd',
      saveTarget: 'MK-51035',
      saves: [
        remoteSave({ emulator: 'flycast', file_name: 'Crazy Taxi (USA).bin', file_size_bytes: 12 })
      ],
      remoteFile: 'VMU from far'
    })
    const dir = join(rig.saves, 'dreamcast')
    plant(dir, VMU_DIR)
    age(dir)
    const others = hashes(dir, DC_OWNED)

    const pulled = await rig.sync.pullNow(rig.target)

    assert.equal(pulled.saves, 1)
    assert.equal(readFileSync(join(dir, 'MK-51035.A1.bin'), 'utf8'), 'VMU from far')
    assert.deepEqual(hashes(dir, DC_OWNED), others)
    assert.equal(existsSync(join(dir, 'Crazy Taxi (USA).bin')), false)
  })

  test('a first pull on a device with no VMU yet creates the one Flycast opens', async () => {
    const rig = retroDeck({
      system: 'dreamcast',
      romFile: 'Crazy Taxi (USA).chd',
      saveTarget: 'MK-51035',
      saves: [
        remoteSave({ emulator: 'flycast', file_name: 'Crazy Taxi (USA).bin', file_size_bytes: 12 })
      ],
      remoteFile: 'VMU from far'
    })
    await rig.sync.pullNow(rig.target)
    assert.deepEqual(readdirSync(join(rig.saves, 'dreamcast')), ['MK-51035.A1.bin'])
  })
})
