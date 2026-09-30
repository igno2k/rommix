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
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { SaveUnit } from '@config/emulators'
import { dreamcastUnit } from '@config/emulators/units/dc.ts'
import { gameCubeUnit } from '@config/emulators/units/gc.ts'
import { ps2Unit } from '@config/emulators/units/ps2.ts'
import { pspUnit } from '@config/emulators/units/psp.ts'
import {
  DC_KEY,
  DC_OWNED,
  GCI_FOLDER,
  GC_KEY,
  GC_OWNED,
  PS2_CARD,
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
import { findUnit, removeUnit, restoreUnit } from './saveunits.ts'
import { zipDirectory, zipMembers } from './zip.ts'

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
    assert.deepEqual(found, { members: [], newest: 0 })
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
