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
import { PS2_CARD, PS2_OWNED, type FixtureTree } from '@config/emulators/units/fixtures.ts'
import type { RommRom, RommSave } from '@shared/types'
import type { RommClient } from './romm/index.ts'
import { runningIn } from './host.ts'
import { SaveSync, type SaveTarget } from './saves.ts'
import { Store } from './store.ts'
import { zipContentHash, zipDirectory, zipRoots } from './zip.ts'

/**
 * Save sync through RetroDECK's PCSX2 folder card, end to end against a fake
 * RomM.
 *
 * What `saveunits.test.ts` proves of the swap on its own is proved here of the
 * whole path a launch takes: the descriptor resolves the unit from RomM's key,
 * the push sends the game's folders under the name and slot Argosy uses, and
 * the pull brings the slot down over those folders and nothing else — asserted
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

interface Uploaded {
  fileName: string
  emulator: string | null
  slot: string | null
  bytes: Buffer
}

/** A RetroDECK install with one PS2 game on its card, and a RomM that holds `saves` for it. */
function retroDeck(options: {
  romFile: string
  saveTarget?: string
  saves?: RommSave[]
  /** What a download hands back: the game's folders, zipped as an upload is. */
  remote?: FixtureTree
  /** `flatpak ps --columns=application`, null where flatpak cannot be run. */
  flatpakPs?: string | null
  /** The command lines of the processes running on this machine. */
  processes?: string[]
  /** What is on the card. */
  card: FixtureTree
}): {
  sync: SaveSync
  target: SaveTarget
  card: string
  backups: string
  uploaded: Uploaded[]
} {
  const home = scratch()
  const rd = join(home, 'retrodeck')
  const romDir = join(rd, 'roms', 'ps2')
  mkdirSync(romDir, { recursive: true })
  const romPath = join(romDir, options.romFile)
  writeFileSync(romPath, 'rom')
  const card = join(rd, 'saves', 'ps2', 'pcsx2', 'memcards', 'Mcd001.ps2')
  plant(card, options.card)
  age(card)

  const uploaded: Uploaded[] = []
  const client = {
    saves: async () => options.saves ?? [],
    states: async () => [],
    devices: async () => [],
    downloadSave: async (_id: number, to: string) => {
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
    install: { location: join(home, 'install') },
    configDir: join(home, 'config'),
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
    platform_id: 7,
    platform_slug: 'ps2',
    platform_fs_slug: 'ps2',
    save_target: options.saveTarget ?? null
  } as RommRom

  const backups = join(home, 'save-copies')
  return {
    sync: new SaveSync(new Store(join(home, 'rommix')), client, backups, async (busy) =>
      runningIn(options.flatpakPs ?? null, (options.processes ?? []).join('\n'), busy, 0)
    ),
    target: { rom, emulator, system: 'ps2', romPath },
    card,
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

const PS2_REMOTE: FixtureTree = {
  'BASLUS-20152AC04/icon.sys': 'icon of the first game',
  'BASLUS-20152AC04/BASLUS-20152AC04': 'progress made on the other device',
  'BASLUS-20152SYS/icon.sys': 'system icon of the first game',
  'BASLUS-20152SYS/settings': 'settings changed on the other device'
}

describe('PCSX2 folder card', () => {
  function ps2(
    options: {
      saves?: RommSave[]
      remote?: FixtureTree
      processes?: string[]
      flatpakPs?: string | null
    } = {}
  ) {
    return retroDeck({
      romFile: 'Jak and Daxter (USA).chd',
      saveTarget: 'SLUS-20152',
      card: PS2_CARD,
      ...options
    })
  }

  /** The game's folders on the fixture card, as they are there. */
  const OWN = Object.fromEntries(
    Object.entries(PS2_CARD).filter(([path]) =>
      PS2_OWNED.some((member) => path.startsWith(`${member}/`))
    )
  )

  test('a push zips the game’s folders as they are, PCSX2’s files inside them included', async () => {
    const { sync, target, card, uploaded } = ps2()
    writeFileSync(join(card, 'BASLUS-20152SYS', '_pcsx2_meta_directory'), 'entry')
    assert.equal((await sync.pushNow(target)).saves, 1)

    const archive = join(scratch(), 'up.zip')
    writeFileSync(archive, uploaded[0].bytes)
    assert.equal(
      await zipContentHash(archive),
      await rommHashOf({ ...OWN, 'BASLUS-20152SYS/_pcsx2_meta_directory': 'entry' })
    )
  })

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

  test('a pull writes the archive’s files into the game’s folders, and every other byte on the card stays', async () => {
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
    // The ids Argosy uploads under, from its own emulator registry.
    for (const emulator of ['nethersx2', 'aethersx2', 'armsx2', 'armsx2_refresh', 'psx2']) {
      const forked = ps2({ saves: [remoteSave({ emulator })], remote: PS2_REMOTE })
      assert.equal((await forked.sync.pullNow(forked.target)).saves, 1, emulator)
    }

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

  test('a copy in the slot that is not an archive counts as failed and is not unpacked', async () => {
    // A card image another client filed under the slot.
    const { sync, target, card } = ps2({
      saves: [remoteSave({ file_name: 'Mcd001 [2026-09-01 12-00-00].ps2' })],
      remote: PS2_REMOTE
    })
    const before = hashes(card)

    const result = await sync.pullNow(target)

    assert.deepEqual([result.saves, result.failed], [0, 1])
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
    const { sync, target, backups } = ps2({
      saves: [remoteSave({ content_hash: await rommHashOf(OWN) })],
      remote: OWN
    })

    assert.equal((await sync.pullNow(target)).saves, 0)
    assert.equal(existsSync(backups), false)
    const [row] = await sync.listAssets(42, target)
    assert.equal(row.sync, 'synced')
  })

  test('nothing is written into the card while RetroDECK or PCSX2 runs, and the reason is given', async () => {
    for (const running of [
      // RetroDECK itself, as flatpak lists it.
      { flatpakPs: 'net.retrodeck.retrodeck' },
      // A PS2 game, where flatpak cannot be asked: PCSX2 under a bwrap that
      // names no flatpak.
      { flatpakPs: null, processes: ['4343 /app/bin/pcsx2-qt -batch /roms/ps2/game.chd'] }
    ]) {
      const { sync, target, card } = ps2({ saves: [remoteSave()], remote: PS2_REMOTE, ...running })
      const before = hashes(card)
      await assert.rejects(sync.pullNow(target), /Close RetroDECK/)
      assert.deepEqual(hashes(card), before)

      // A copy only this device has, deleted here.
      const local = ps2(running)
      const kept = hashes(local.card)
      await assert.rejects(
        local.sync.deleteAsset(42, 'save', null, 'Jak and Daxter (USA).zip', 'local', local.target),
        /Close RetroDECK/
      )
      assert.deepEqual(hashes(local.card), kept)
    }
  })

  test('a pull with nothing to bring down is not refused for a running emulator', async () => {
    const { sync, target } = ps2({ flatpakPs: 'net.retrodeck.retrodeck' })
    assert.equal((await sync.pullNow(target)).saves, 0)
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
    const rig = retroDeck({ romFile: 'Jak.chd', card: PS2_CARD })
    const result = await rig.sync.pushNow(rig.target)
    assert.equal(result.saves, 0)
    assert.match(result.skippedReason ?? '', /RomM 5\.3/)
  })
})
