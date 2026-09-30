import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { SaveUnit } from '@config/emulators'
import { dreamcastUnit } from '@config/emulators/units/dc.ts'
import { gameCubeUnit } from '@config/emulators/units/gc.ts'
import { ps2Unit, PS2_FOLDER_FILES } from '@config/emulators/units/ps2.ts'
import { pspUnit } from '@config/emulators/units/psp.ts'
import {
  DC_KEY,
  DC_OWNED,
  GCI_FOLDER,
  GC_KEY,
  GC_OWNED,
  PS2_CARD,
  PS2_FILTER_CARD,
  PS2_FILTER_KEY,
  PS2_FILTER_OWN,
  PS2_FILTER_SHARED,
  PS2_KEY,
  PS2_OWNED,
  PSP_KEY,
  PSP_OWNED,
  SAVEDATA,
  VMU_DIR,
  gci,
  paramSfo,
  type FixtureTree
} from '@config/emulators/units/fixtures.ts'
import { fileSystemEnvironment } from './saveenv.ts'
import { backupPath } from './savefiles.ts'
import { findUnit, plantSeed, removeUnit, restoreUnit } from './saveunits.ts'
import { extractZip, membersContentHash, zipDirectory, zipMembers } from './zip.ts'

/**
 * One game's entries in a folder every game shares, on a real disk.
 *
 * The assertion that matters most is the one about everything else: after a
 * pull, every byte in the folder that is not the game's is exactly what it was
 * — the other game's saves, the card's own superblock, the entries a rule
 * refuses to claim. It is asserted as a hash of the whole tree minus the game's
 * members, before and after, so a pull that touched anything else fails however
 * it touched it.
 */

const scratches: string[] = []
afterEach(() => {
  for (const dir of scratches.splice(0)) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rommix-saveunits-test-'))
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

/** Every file under `root`, relative path -> sha256, minus what `skip` names. */
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

/** The four systems, each with its folder, its rule, and what the game owns in it. */
interface Case {
  name: string
  folder: FixtureTree
  owned: readonly string[]
  unit: () => SaveUnit
  /** The same entries as another device has them, changed. */
  remote: FixtureTree
}

const env = fileSystemEnvironment()

const ARCHIVE_CASES: Case[] = [
  {
    name: 'PS2 folder card',
    folder: PS2_CARD,
    owned: PS2_OWNED,
    unit: () => ps2Unit(PS2_KEY) as SaveUnit,
    remote: {
      'BASLUS-20152AC04/icon.sys': 'icon of the first game',
      'BASLUS-20152AC04/BASLUS-20152AC04': 'progress made on the other device',
      'BASLUS-20152SYS/icon.sys': 'system icon of the first game',
      'BASLUS-20152SYS/settings': 'settings changed on the other device'
    }
  },
  {
    name: 'GCI folder',
    folder: GCI_FOLDER,
    owned: GC_OWNED,
    unit: () => gameCubeUnit(GC_KEY, env),
    remote: {
      '01-GZLE-gczelda2.gci': gci('GZLE01', 'gczelda2', 'further on the other device'),
      '01-GZLE-gczelda2b.gci': gci('GZLE01', 'gczelda2b', 'second quest, also further')
    }
  },
  {
    name: 'SAVEDATA',
    folder: SAVEDATA,
    owned: PSP_OWNED,
    unit: () => pspUnit(PSP_KEY, env) as SaveUnit,
    remote: {
      'ULUS10064DATA00/PARAM.SFO': paramSfo(['SAVEDATA_PARAMS']),
      'ULUS10064DATA00/DATA.BIN': 'first slot, played elsewhere',
      'ULUS10064DATA01/PARAM.SFO': paramSfo(['SAVEDATA_PARAMS']),
      'ULUS10064DATA01/DATA.BIN': 'second slot, played elsewhere',
      'ULUS10064SETTINGS/PARAM.SFO': paramSfo(['SAVEDATA_PARAMS']),
      'ULUS10064SETTINGS/SETTINGS.BIN': 'options, changed'
    }
  }
]

/** Another device's copy of the game's entries, zipped the way an upload is. */
async function remoteArchive(remote: FixtureTree): Promise<string> {
  const root = scratch()
  plant(join(root, 'other'), remote)
  const names = [...new Set(Object.keys(remote).map((path) => path.split('/')[0]))]
  const archive = join(root, 'unit.zip')
  await zipMembers(join(root, 'other'), names, archive)
  return archive
}

const REMOTE_TIME = Date.parse('2026-09-01T12:00:00Z')

describe('finding a game’s entries', () => {
  for (const one of ARCHIVE_CASES) {
    test(`${one.name}: exactly the game's members, and how new they are`, async () => {
      const dir = join(scratch(), 'shared')
      plant(dir, one.folder)
      const found = await findUnit(dir, one.unit())
      assert.deepEqual(found.members, [...one.owned].sort())
      assert.ok(found.newest > 0)
    })
  }

  test('Dreamcast VMU: the one product-named file', async () => {
    const dir = join(scratch(), 'dreamcast')
    plant(dir, VMU_DIR)
    assert.deepEqual((await findUnit(dir, dreamcastUnit(DC_KEY) as SaveUnit)).members, [
      ...DC_OWNED
    ])
  })

  test('a folder that is not there holds nothing', async () => {
    const found = await findUnit(join(scratch(), 'missing'), ps2Unit(PS2_KEY) as SaveUnit)
    assert.deepEqual(found, { members: [], shared: [], newest: 0 })
  })
})

describe('pulling a game’s entries', () => {
  for (const one of ARCHIVE_CASES) {
    test(`${one.name}: the game's entries are replaced and nothing else changes by a byte`, async () => {
      const root = scratch()
      const dir = join(root, 'shared')
      plant(dir, one.folder)
      const backups = join(root, 'backups')
      const others = hashes(dir, one.owned)

      const wrote = await restoreUnit({
        dir,
        unit: one.unit(),
        archive: await remoteArchive(one.remote),
        backups,
        remoteTime: REMOTE_TIME,
        romId: 7
      })

      assert.deepEqual(wrote.sort(), [...one.owned].sort())
      assert.deepEqual(hashes(dir, one.owned), others)
      for (const [path, contents] of Object.entries(one.remote)) {
        assert.equal(readFileSync(join(dir, path), 'latin1'), contents, path)
        assert.equal(statSync(join(dir, path)).mtimeMs, REMOTE_TIME, path)
      }
      // One copy per member, taken of what was there before.
      for (const member of one.owned) {
        assert.ok(existsSync(backupPath(backups, join(dir, member), 1)), member)
      }
      // Nothing left beside the folder.
      assert.deepEqual(readdirSync(root).sort(), ['backups', 'shared'])
    })
  }

  test('SAVEDATA: a slot the pulled copy no longer has is removed, after its copy is kept', async () => {
    const root = scratch()
    const dir = join(root, 'SAVEDATA')
    plant(dir, SAVEDATA)
    const backups = join(root, 'backups')
    const remote = Object.fromEntries(
      Object.entries(ARCHIVE_CASES[2].remote).filter(
        ([path]) => !path.startsWith('ULUS10064DATA01')
      )
    )

    await restoreUnit({
      dir,
      unit: pspUnit(PSP_KEY, env) as SaveUnit,
      archive: await remoteArchive(remote),
      backups,
      remoteTime: REMOTE_TIME,
      romId: 7
    })

    assert.equal(existsSync(join(dir, 'ULUS10064DATA01')), false)
    assert.ok(existsSync(join(backupPath(backups, join(dir, 'ULUS10064DATA01'), 1), 'DATA.BIN')))
    // The installed game data is not the game's save, and stays.
    assert.ok(existsSync(join(dir, 'ULUS10064INSTALL', 'DATA.PAK')))
  })

  test('an archive carrying another game’s entry is refused whole, and nothing moves', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const before = hashes(dir)

    await assert.rejects(
      restoreUnit({
        dir,
        unit: ps2Unit(PS2_KEY) as SaveUnit,
        archive: await remoteArchive({
          ...ARCHIVE_CASES[0].remote,
          'BASLUS-21693XX/BASLUS-21693XX': 'somebody else’s progress'
        }),
        backups: join(root, 'backups'),
        remoteTime: REMOTE_TIME,
        romId: 7
      }),
      /not this game/
    )
    assert.deepEqual(hashes(dir), before)
    assert.equal(existsSync(join(root, 'backups')), false)
  })

  test('an archive carrying the card’s superblock is refused', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const before = hashes(dir)

    await assert.rejects(
      restoreUnit({
        dir,
        unit: ps2Unit(PS2_KEY) as SaveUnit,
        archive: await remoteArchive({
          ...ARCHIVE_CASES[0].remote,
          _pcsx2_superblock: 'another card'
        }),
        backups: join(root, 'backups'),
        remoteTime: REMOTE_TIME,
        romId: 7
      })
    )
    assert.deepEqual(hashes(dir), before)
  })

  test('a GCI that names another game in its header is refused, whatever it is called', async () => {
    const root = scratch()
    const dir = join(root, 'Card A')
    plant(dir, GCI_FOLDER)
    const before = hashes(dir)

    await assert.rejects(
      restoreUnit({
        dir,
        unit: gameCubeUnit(GC_KEY, env),
        archive: await remoteArchive({ '01-GZLE-gczelda2.gci': gci('GM4E8P', 'MarioKart', 'x') }),
        backups: join(root, 'backups'),
        remoteTime: REMOTE_TIME,
        romId: 7
      })
    )
    assert.deepEqual(hashes(dir), before)
  })

  test('a whole card zipped by another client gives up only the game’s folders', async () => {
    const root = scratch()
    const dir = join(root, 'Mcd001.ps2')
    plant(dir, PS2_CARD)
    const others = hashes(dir, PS2_OWNED)

    // The card as somebody else's device has it: its own superblock, another
    // game's progress, and this game's two folders.
    const legacy = join(root, 'legacy')
    plant(join(legacy, 'Mcd002.ps2'), {
      ...ARCHIVE_CASES[0].remote,
      _pcsx2_superblock: 'the other device card',
      'BASLUS-21693XX/BASLUS-21693XX': 'their progress in the other game'
    })
    const archive = join(root, 'legacy.zip')
    await zipDirectory(legacy, archive)

    const wrote = await restoreUnit({
      dir,
      unit: ps2Unit(PS2_KEY) as SaveUnit,
      archive,
      backups: join(root, 'backups'),
      remoteTime: REMOTE_TIME,
      romId: 7
    })

    assert.deepEqual(wrote.sort(), [...PS2_OWNED].sort())
    assert.deepEqual(hashes(dir, PS2_OWNED), others)
    assert.equal(
      readFileSync(join(dir, 'BASLUS-20152AC04', 'BASLUS-20152AC04'), 'latin1'),
      'progress made on the other device'
    )
  })

  test('an empty archive is refused rather than read as "delete everything"', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const before = hashes(dir)
    const archive = join(root, 'empty.zip')
    // Built by hand: the writer declines to make an archive of nothing.
    writeFileSync(archive, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'))

    await assert.rejects(
      restoreUnit({
        dir,
        unit: ps2Unit(PS2_KEY) as SaveUnit,
        archive,
        backups: join(root, 'backups'),
        remoteTime: REMOTE_TIME,
        romId: 7
      })
    )
    assert.deepEqual(hashes(dir), before)
  })

  test('no copy can be kept, so nothing is replaced', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const before = hashes(dir)
    // A file where the backup folder should be: nothing can be copied into it.
    writeFileSync(join(root, 'backups'), 'in the way')

    await assert.rejects(
      restoreUnit({
        dir,
        unit: ps2Unit(PS2_KEY) as SaveUnit,
        archive: await remoteArchive(ARCHIVE_CASES[0].remote),
        backups: join(root, 'backups'),
        remoteTime: REMOTE_TIME,
        romId: 7
      }),
      /could not keep a copy/
    )
    assert.deepEqual(hashes(dir), before)
  })

  test('a swap that cannot happen leaves the card as it was and the copies taken', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const before = hashes(dir)
    const backups = join(root, 'backups')
    // The card can be read, so the copies are taken, but not written to.
    chmodSync(dir, 0o555)

    try {
      await assert.rejects(
        restoreUnit({
          dir,
          unit: ps2Unit(PS2_KEY) as SaveUnit,
          archive: await remoteArchive(ARCHIVE_CASES[0].remote),
          backups,
          remoteTime: REMOTE_TIME,
          romId: 7
        })
      )
    } finally {
      chmodSync(dir, 0o755)
    }
    assert.deepEqual(hashes(dir), before)
    for (const member of PS2_OWNED) assert.ok(existsSync(backupPath(backups, join(dir, member), 1)))
  })

  test('a swap that fails on the second member puts the first one back too', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const before = hashes(dir)
    const failing = async (from: string, to: string): Promise<void> => {
      // The second member on its way in from the unpacked copy.
      if (from.includes('.part') && from.endsWith(`/${PS2_OWNED[1]}`)) {
        throw new Error('the disk said no')
      }
      await rename(from, to)
    }

    await assert.rejects(
      restoreUnit({
        dir,
        unit: ps2Unit(PS2_KEY) as SaveUnit,
        archive: await remoteArchive(ARCHIVE_CASES[0].remote),
        backups: join(root, 'backups'),
        remoteTime: REMOTE_TIME,
        romId: 7,
        move: failing
      }),
      /the disk said no/
    )
    assert.deepEqual(hashes(dir), before)
    assert.deepEqual(readdirSync(root).sort(), ['backups', 'card'])
  })

  test('a swap that cannot be undone keeps the displaced entries rather than cleaning them away', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const failing = async (from: string, to: string): Promise<void> => {
      const incoming = from.includes('.part') && from.endsWith(`/${PS2_OWNED[1]}`)
      const goingBack = from.includes('.old') && from.endsWith(`/${PS2_OWNED[0]}`)
      if (incoming || goingBack) throw new Error('the disk said no')
      await rename(from, to)
    }

    await assert.rejects(
      restoreUnit({
        dir,
        unit: ps2Unit(PS2_KEY) as SaveUnit,
        archive: await remoteArchive(ARCHIVE_CASES[0].remote),
        backups: join(root, 'backups'),
        remoteTime: REMOTE_TIME,
        romId: 7,
        move: failing
      })
    )
    const kept = readdirSync(root).find((name) => name.endsWith('.old'))
    assert.ok(kept, 'the displaced copies are still beside the card')
    assert.equal(
      readFileSync(join(root, kept, PS2_OWNED[0], 'BASLUS-20152AC04'), 'latin1'),
      PS2_CARD['BASLUS-20152AC04/BASLUS-20152AC04']
    )
  })

  test('an archive is judged by its roots before anything is unpacked', async () => {
    const root = scratch()
    const dir = join(root, 'Card A')
    plant(dir, GCI_FOLDER)
    const before = hashes(dir)
    let moved = 0
    await assert.rejects(
      restoreUnit({
        dir,
        unit: gameCubeUnit(GC_KEY, env),
        // The right header under a name that names another game: refused on
        // the name, before the header is ever read.
        archive: await remoteArchive({ '8P-GM4E-x.gci': gci('GZLE01', 'x', 'y') }),
        backups: join(root, 'backups'),
        remoteTime: REMOTE_TIME,
        romId: 7,
        move: async (from, to) => {
          moved += 1
          await rename(from, to)
        }
      }),
      /not this game/
    )
    assert.equal(moved, 0)
    assert.deepEqual(hashes(dir), before)
    assert.deepEqual(readdirSync(root), ['Card A'])
  })

  test('a GCI named by hand is judged by its header once unpacked, both ways', async () => {
    const root = scratch()
    const dir = join(root, 'Card A')
    plant(dir, GCI_FOLDER)
    const others = hashes(dir)

    // The game's own save under a name that says nothing: taken.
    const wrote = await restoreUnit({
      dir,
      unit: gameCubeUnit(GC_KEY, env),
      archive: await remoteArchive({
        ...ARCHIVE_CASES[1].remote,
        'zelda.gci': gci('GZLE01', 'zelda', 'named by hand')
      }),
      backups: join(root, 'backups'),
      remoteTime: REMOTE_TIME,
      romId: 7
    })
    assert.ok(wrote.includes('zelda.gci'))

    // Another game's save under a name that says nothing: refused on the header.
    const after = hashes(dir)
    await assert.rejects(
      restoreUnit({
        dir,
        unit: gameCubeUnit(GC_KEY, env),
        archive: await remoteArchive({ 'kart.gci': gci('GM4E8P', 'kart', 'x') }),
        backups: join(root, 'backups'),
        remoteTime: REMOTE_TIME,
        romId: 7
      }),
      /not this game/
    )
    assert.deepEqual(hashes(dir), after)
    assert.equal(
      hashes(dir)['8P-GM4E-MarioKart Double Dash!!.gci'],
      others['8P-GM4E-MarioKart Double Dash!!.gci']
    )
  })

  test('copies rotate per member rather than piling up', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const backups = join(root, 'backups')
    for (let pull = 0; pull < 5; pull += 1) {
      await restoreUnit({
        dir,
        unit: ps2Unit(PS2_KEY) as SaveUnit,
        archive: await remoteArchive(ARCHIVE_CASES[0].remote),
        backups,
        remoteTime: REMOTE_TIME,
        romId: 7
      })
    }
    assert.deepEqual(readdirSync(backups).sort(), [
      'BASLUS-20152AC04.1',
      'BASLUS-20152AC04.2',
      'BASLUS-20152AC04.3',
      'BASLUS-20152SYS.1',
      'BASLUS-20152SYS.2',
      'BASLUS-20152SYS.3'
    ])
  })

  test('a folder the emulator has not made yet is made for the first pull', async () => {
    const root = scratch()
    const dir = join(root, 'US', 'Card A')
    await restoreUnit({
      dir,
      unit: gameCubeUnit(GC_KEY, env),
      archive: await remoteArchive(ARCHIVE_CASES[1].remote),
      backups: join(root, 'backups'),
      remoteTime: REMOTE_TIME,
      romId: 7
    })
    assert.deepEqual(readdirSync(dir).sort(), [...GC_OWNED].sort())
  })
})

describe('PCSX2’s own files inside a save folder', () => {
  /**
   * The card, with PCSX2's index in one of the game's folders and the
   * metadata of an entry the host cannot name in the other — the index is
   * PCSX2's bookkeeping, the metadata part of the save.
   */
  const INDEXED: FixtureTree = {
    ...PS2_CARD,
    'BASLUS-20152AC04/_pcsx2_index': 'local index of the first folder',
    'BASLUS-20152SYS/_pcsx2_meta_directory': 'raw directory entry of the folder',
    'BASLUS-20152SYS/_pcsx2_meta/settings': 'raw directory entry of a file'
  }
  const unit = (): SaveUnit => ps2Unit(PS2_KEY) as SaveUnit

  test('the index is neither archived nor hashed; the metadata is both', async () => {
    const root = scratch()
    plant(join(root, 'with'), INDEXED)
    const withoutIndex = Object.fromEntries(
      Object.entries(INDEXED).filter(([path]) => !path.endsWith('/_pcsx2_index'))
    )
    plant(join(root, 'without'), withoutIndex)
    const ignore = unit().ignoresInside ?? []
    assert.deepEqual(ignore, ['_pcsx2_index'])
    assert.deepEqual(PS2_FOLDER_FILES, ['_pcsx2_index'])

    const archive = join(root, 'up.zip')
    await zipMembers(join(root, 'with'), PS2_OWNED, archive, ignore)
    const inside = await remoteNames(archive)
    assert.ok(!inside.some((name) => name.endsWith('_pcsx2_index')), inside.join(', '))
    assert.ok(inside.includes('BASLUS-20152SYS/_pcsx2_meta_directory'), inside.join(', '))
    assert.ok(inside.includes('BASLUS-20152SYS/_pcsx2_meta/settings'), inside.join(', '))
    assert.equal(
      await membersContentHash(join(root, 'with'), PS2_OWNED, ignore),
      await membersContentHash(join(root, 'without'), PS2_OWNED, ignore)
    )
    // Asked without the rule, the two differ: the index is really there.
    assert.notEqual(
      await membersContentHash(join(root, 'with'), PS2_OWNED),
      await membersContentHash(join(root, 'without'), PS2_OWNED)
    )
  })

  test('the index does not make the game read as newer', async () => {
    const dir = join(scratch(), 'card')
    plant(dir, INDEXED)
    const old = new Date('2026-08-01T00:00:00Z')
    for (const file of Object.keys(INDEXED).filter((path) => path.startsWith('BASLUS-20152')))
      utimesSync(join(dir, file), old, old)
    const late = new Date('2026-09-20T00:00:00Z')
    utimesSync(join(dir, 'BASLUS-20152AC04/_pcsx2_index'), late, late)
    assert.equal((await findUnit(dir, unit())).newest, old.getTime())
  })

  test('a pull writes the index an archive carries, and the metadata like any file', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, INDEXED)
    const wrote = await restoreUnit({
      dir,
      unit: unit(),
      archive: await remoteArchive({
        ...ARCHIVE_CASES[0].remote,
        'BASLUS-20152AC04/_pcsx2_index': 'index from the other device',
        'BASLUS-20152SYS/_pcsx2_meta_directory': 'directory entry from the other device'
      }),
      backups: join(root, 'backups'),
      remoteTime: REMOTE_TIME,
      romId: 7
    })
    assert.deepEqual(wrote, [...PS2_OWNED].sort())
    // The archive's index describes the files it came with.
    assert.equal(
      readFileSync(join(dir, 'BASLUS-20152AC04', '_pcsx2_index'), 'latin1'),
      'index from the other device'
    )
    // The metadata is the save's: the archive's, and none the archive lacks.
    assert.equal(
      readFileSync(join(dir, 'BASLUS-20152SYS', '_pcsx2_meta_directory'), 'latin1'),
      'directory entry from the other device'
    )
    assert.equal(existsSync(join(dir, 'BASLUS-20152SYS', '_pcsx2_meta')), false)
    // No index where neither end had one.
    assert.equal(existsSync(join(dir, 'BASLUS-20152SYS', '_pcsx2_index')), false)
  })

  test('a pull whose archive has no index keeps this device’s', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, INDEXED)
    await restoreUnit({
      dir,
      unit: unit(),
      archive: await remoteArchive(ARCHIVE_CASES[0].remote),
      backups: join(root, 'backups'),
      remoteTime: REMOTE_TIME,
      romId: 7
    })
    assert.equal(
      readFileSync(join(dir, 'BASLUS-20152AC04', '_pcsx2_index'), 'latin1'),
      'local index of the first folder'
    )
    assert.equal(
      readFileSync(join(dir, 'BASLUS-20152AC04', 'BASLUS-20152AC04'), 'latin1'),
      'progress made on the other device'
    )
    assert.equal(existsSync(join(dir, 'BASLUS-20152SYS', '_pcsx2_index')), false)
  })
})

/** Every file inside an archive, by its path in it. */
async function remoteNames(archive: string): Promise<string[]> {
  const out = join(scratch(), 'x')
  await extractZip(archive, out, { maxBytes: 1 << 20 })
  const names: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else names.push(relative(out, path))
    }
  }
  visit(out)
  return names
}

describe('a PS2 game whose GameDB filters reach another game’s folder', () => {
  /** Ratchet & Clank 2, which reads Ratchet & Clank's save. */
  const ratchet2 = (): SaveUnit =>
    ps2Unit(PS2_FILTER_KEY, { filters: ['SCUS-97268', 'SCUS-97199'] }) as SaveUnit
  const UNIT = [...PS2_FILTER_OWN, ...PS2_FILTER_SHARED]

  test('a push finds both, and not the console’s folders', async () => {
    const dir = join(scratch(), 'card')
    plant(dir, PS2_FILTER_CARD)
    const found = await findUnit(dir, ratchet2())
    assert.deepEqual(found.members, [...UNIT].sort())
    assert.deepEqual(found.shared, [...PS2_FILTER_SHARED])
  })

  test('playing the other game does not make this one read as newer', async () => {
    const dir = join(scratch(), 'card')
    plant(dir, PS2_FILTER_CARD)
    const old = new Date('2026-08-01T00:00:00Z')
    const played = new Date('2026-09-20T00:00:00Z')
    for (const file of ['icon.sys', 'save']) {
      utimesSync(join(dir, PS2_FILTER_OWN[0], file), old, old)
      utimesSync(join(dir, PS2_FILTER_SHARED[0], file), played, played)
    }
    assert.equal((await findUnit(dir, ratchet2())).newest, old.getTime())
  })

  test('a pull never replaces a shared folder that is there, even with a copy it carries', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_FILTER_CARD)
    const others = hashes(dir, PS2_FILTER_OWN)
    const sharedMtime = statSync(join(dir, PS2_FILTER_SHARED[0], 'save')).mtimeMs

    const wrote = await restoreUnit({
      dir,
      unit: ratchet2(),
      archive: await remoteArchive({
        'BASCUS-97268RATCHET2/save': 'Ratchet 2 on the other device',
        'BASCUS-97199RATCHET/save': 'Ratchet 1 on the other device'
      }),
      backups: join(root, 'backups'),
      remoteTime: REMOTE_TIME,
      romId: 7
    })
    assert.deepEqual(wrote, [...PS2_FILTER_OWN])
    // The first game's folder — and everything else — is byte for byte what it
    // was, and not even re-dated.
    assert.deepEqual(hashes(dir, PS2_FILTER_OWN), others)
    assert.equal(statSync(join(dir, PS2_FILTER_SHARED[0], 'save')).mtimeMs, sharedMtime)
    assert.equal(
      readFileSync(join(dir, 'BASCUS-97268RATCHET2', 'save'), 'latin1'),
      'Ratchet 2 on the other device'
    )
    assert.equal(
      existsSync(backupPath(join(root, 'backups'), join(dir, PS2_FILTER_SHARED[0]), 1)),
      false
    )
  })

  test('a pull writes a shared folder where there is none', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_FILTER_CARD)
    rmSync(join(dir, PS2_FILTER_SHARED[0]), { recursive: true })

    const wrote = await restoreUnit({
      dir,
      unit: ratchet2(),
      archive: await remoteArchive({
        'BASCUS-97268RATCHET2/save': 'Ratchet 2 on the other device',
        'BASCUS-97199RATCHET/save': 'Ratchet 1 on the other device'
      }),
      backups: join(root, 'backups'),
      remoteTime: REMOTE_TIME,
      romId: 7
    })
    assert.deepEqual(wrote, [...UNIT].sort())
    assert.equal(
      readFileSync(join(dir, 'BASCUS-97199RATCHET', 'save'), 'latin1'),
      'Ratchet 1 on the other device'
    )
  })

  test('a ROM whose serial is another game’s changes none of that serial’s folders', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, {
      ...PS2_CARD,
      'BASLUS-20066SYSTEM/system.cfg': 'Half-Life settings'
    })
    const before = hashes(dir)
    const blueShift = ps2Unit('SLUS-20066', { serialShared: true }) as SaveUnit

    const wrote = await restoreUnit({
      dir,
      unit: blueShift,
      archive: await remoteArchive({ 'BASLUS-20066SYSTEM/system.cfg': 'Blue Shift’s copy' }),
      backups: join(root, 'backups'),
      remoteTime: REMOTE_TIME,
      romId: 8
    })
    assert.deepEqual(wrote, [])
    assert.deepEqual(hashes(dir), before)
    assert.deepEqual(await removeUnit(dir, blueShift, join(root, 'backups')), [])
    assert.deepEqual(hashes(dir), before)
    assert.equal((await findUnit(dir, blueShift)).newest, 0)
  })

  test('a pull without the shared folder leaves it where it is', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_FILTER_CARD)
    const before = hashes(dir, PS2_FILTER_OWN)

    await restoreUnit({
      dir,
      unit: ratchet2(),
      archive: await remoteArchive({
        'BASCUS-97268RATCHET2/save': 'Ratchet 2 on the other device'
      }),
      backups: join(root, 'backups'),
      remoteTime: REMOTE_TIME,
      romId: 7
    })
    // The first game's save is still there, byte for byte.
    assert.deepEqual(hashes(dir, PS2_FILTER_OWN), before)
  })

  test('an archive carrying the console’s system folder is refused whole', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_FILTER_CARD)
    const before = hashes(dir)

    for (const system of ['BADATA-SYSTEM', 'BWNETCNF']) {
      await assert.rejects(
        restoreUnit({
          dir,
          unit: ratchet2(),
          archive: await remoteArchive({
            'BASCUS-97268RATCHET2/save': 'Ratchet 2 on the other device',
            [`${system}/history`]: 'another console’s history'
          }),
          backups: join(root, 'backups'),
          remoteTime: REMOTE_TIME,
          romId: 7
        }),
        /not this game/
      )
    }
    assert.deepEqual(hashes(dir), before)
  })

  test('deleting the game’s saves leaves the folder it shares', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_FILTER_CARD)
    const others = hashes(dir, PS2_FILTER_OWN)

    assert.deepEqual(await removeUnit(dir, ratchet2(), join(root, 'backups')), [...PS2_FILTER_OWN])
    assert.deepEqual(hashes(dir), others)
  })
})

describe('deleting a game’s entries here', () => {
  test('only the game’s, each copied aside first', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const others = hashes(dir, PS2_OWNED)
    const backups = join(root, 'backups')

    assert.deepEqual((await removeUnit(dir, ps2Unit(PS2_KEY) as SaveUnit, backups)).sort(), [
      ...PS2_OWNED
    ])
    assert.deepEqual(hashes(dir), others)
    for (const member of PS2_OWNED) assert.ok(existsSync(backupPath(backups, join(dir, member), 1)))
  })
})

describe('plantSeed', () => {
  function seedRig(): { from: string; dir: string; to: string; own: string } {
    const root = scratch()
    const from = join(root, 'bios', 'vmu_save_A1.bin')
    mkdirSync(join(root, 'bios'))
    writeFileSync(from, 'shared')
    const dir = join(root, 'saves', 'dreamcast')
    return { from, dir, to: join(dir, 'Game.A1.bin'), own: join(dir, 'MK-51035.A1.bin') }
  }

  test('copies into a folder that is not there yet, and leaves nothing beside it', async () => {
    const rig = seedRig()
    assert.equal(await plantSeed({ from: rig.from, to: rig.to, unless: [rig.own] }), 'planted')
    assert.equal(readFileSync(rig.to, 'utf8'), 'shared')
    assert.deepEqual(readdirSync(rig.dir), ['Game.A1.bin'])
  })

  test('never over anything, a link to nowhere included', async () => {
    const rig = seedRig()
    mkdirSync(rig.dir, { recursive: true })
    symlinkSync(join(rig.dir, 'gone'), rig.to)
    assert.equal(await plantSeed({ from: rig.from, to: rig.to, unless: [] }), 'present')
    assert.deepEqual(readdirSync(rig.dir), ['Game.A1.bin'])

    const other = seedRig()
    mkdirSync(other.dir, { recursive: true })
    writeFileSync(other.own, 'its own')
    assert.equal(
      await plantSeed({ from: other.from, to: other.to, unless: [other.own] }),
      'present'
    )
    assert.deepEqual(readdirSync(other.dir), ['MK-51035.A1.bin'])
  })

  test('a source that is missing or not a file is nothing to copy', async () => {
    const rig = seedRig()
    const missing = join(rig.dir, '..', 'none.bin')
    assert.equal(await plantSeed({ from: missing, to: rig.to, unless: [] }), 'no-source')
    assert.equal(
      await plantSeed({ from: join(rig.from, '..'), to: rig.to, unless: [] }),
      'no-source'
    )
    assert.equal(existsSync(rig.dir), false)
  })
})
