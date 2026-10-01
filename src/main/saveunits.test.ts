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
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { SaveUnit } from '@config/emulators'
import { ps2Unit } from '@config/emulators/units/ps2.ts'
import { PS2_CARD, PS2_KEY, PS2_OWNED, type FixtureTree } from '@config/emulators/units/fixtures.ts'
import { backupPath } from './savefiles.ts'
import { findUnit, removeUnit, restoreUnit } from './saveunits.ts'
import { zipDirectory, zipMembers } from './zip.ts'

/**
 * One game's folders on a PCSX2 folder card, on a real disk.
 *
 * The assertion that matters most is the one about everything else: after a
 * pull, every byte on the card that is not the game's is exactly what it was —
 * the other game's saves, the card's own files, the console's folders. It is
 * asserted as a hash of the whole tree minus the game's folders, before and
 * after, so a pull that touched anything else fails however it touched it.
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

const unit = (): SaveUnit => ps2Unit(PS2_KEY) as SaveUnit

/** The game's folders as another device has them, changed. */
const REMOTE: FixtureTree = {
  'BASLUS-20152AC04/icon.sys': 'icon of the first game',
  'BASLUS-20152AC04/BASLUS-20152AC04': 'progress made on the other device',
  'BASLUS-20152SYS/icon.sys': 'system icon of the first game',
  'BASLUS-20152SYS/settings': 'settings changed on the other device'
}

/** Another device's copy of the game's folders, zipped the way an upload is. */
async function remoteArchive(remote: FixtureTree): Promise<string> {
  const root = scratch()
  plant(join(root, 'other'), remote)
  const names = [...new Set(Object.keys(remote).map((path) => path.split('/')[0]))]
  const archive = join(root, 'unit.zip')
  await zipMembers(join(root, 'other'), names, archive)
  return archive
}

const REMOTE_TIME = Date.parse('2026-09-01T12:00:00Z')

/** Pull `archive` over the card at `dir`, the rest of the options the usual ones. */
function pull(
  dir: string,
  archive: string,
  options: { unit?: SaveUnit; move?: (from: string, to: string) => Promise<void> } = {}
): Promise<string[]> {
  return restoreUnit({
    dir,
    unit: options.unit ?? unit(),
    archive,
    backups: join(dir, '..', 'backups'),
    remoteTime: REMOTE_TIME,
    romId: 7,
    move: options.move
  })
}

describe('finding a game’s folders', () => {
  test('exactly the game’s, and how new they are', async () => {
    const dir = join(scratch(), 'card')
    plant(dir, PS2_CARD)
    const found = await findUnit(dir, unit())
    assert.deepEqual(found.members, [...PS2_OWNED].sort())
    assert.ok(found.newest > 0)
  })

  test('a card that is not there holds nothing', async () => {
    const found = await findUnit(join(scratch(), 'missing'), unit())
    assert.deepEqual(found, { members: [], newest: 0 })
  })
})

describe('pulling a game’s folders', () => {
  test('the archive’s files are written over the game’s, and nothing else changes by a byte', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const others = hashes(dir, PS2_OWNED)

    assert.deepEqual(await pull(dir, await remoteArchive(REMOTE)), [...PS2_OWNED].sort())
    assert.deepEqual(hashes(dir, PS2_OWNED), others)
    for (const [path, contents] of Object.entries(REMOTE)) {
      assert.equal(readFileSync(join(dir, path), 'latin1'), contents, path)
      assert.equal(statSync(join(dir, path)).mtimeMs, REMOTE_TIME, path)
    }
    // A file only this device has stays, with its date, as Argosy leaves it.
    assert.equal(
      readFileSync(join(dir, 'BASLUS-20152AC04', '_pcsx2_index'), 'latin1'),
      PS2_CARD['BASLUS-20152AC04/_pcsx2_index']
    )
    assert.notEqual(statSync(join(dir, 'BASLUS-20152AC04', '_pcsx2_index')).mtimeMs, REMOTE_TIME)
    for (const member of PS2_OWNED) {
      assert.ok(existsSync(backupPath(join(root, 'backups'), join(dir, member), 1)), member)
    }
    // Nothing left beside the card.
    assert.deepEqual(readdirSync(root).sort(), ['backups', 'card'])
  })

  test('PCSX2’s files inside a save folder travel as they are, both ways', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    await pull(
      dir,
      await remoteArchive({
        ...REMOTE,
        'BASLUS-20152AC04/_pcsx2_index': 'index from the other device',
        'BASLUS-20152SYS/_pcsx2_meta_directory': 'raw directory entry of the folder',
        'BASLUS-20152SYS/_pcsx2_meta/settings': 'raw directory entry of a file'
      })
    )
    assert.equal(
      readFileSync(join(dir, 'BASLUS-20152AC04', '_pcsx2_index'), 'latin1'),
      'index from the other device'
    )
    assert.equal(
      readFileSync(join(dir, 'BASLUS-20152SYS', '_pcsx2_meta', 'settings'), 'latin1'),
      'raw directory entry of a file'
    )
  })

  test('a folder of the game’s the archive does not carry is left where it is', async () => {
    const dir = join(scratch(), 'card')
    plant(dir, PS2_CARD)
    const kept = hashes(join(dir, 'BASLUS-20152SYS'))
    const wrote = await pull(
      dir,
      await remoteArchive({ 'BASLUS-20152AC04/BASLUS-20152AC04': 'progress elsewhere' })
    )
    assert.deepEqual(wrote, ['BASLUS-20152AC04'])
    assert.deepEqual(hashes(join(dir, 'BASLUS-20152SYS')), kept)
  })

  test('a whole card zipped by another client gives up only the game’s folders', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const others = hashes(dir, PS2_OWNED)
    // The card as somebody else's device has it: its own superblock, another
    // game's progress, and this game's two folders.
    plant(join(root, 'legacy', 'Mcd002.ps2'), {
      ...REMOTE,
      _pcsx2_superblock: 'the other device card',
      'BASLUS-21693XX/BASLUS-21693XX': 'their progress in the other game'
    })
    const archive = join(root, 'legacy.zip')
    await zipDirectory(join(root, 'legacy'), archive)

    assert.deepEqual(await pull(dir, archive), [...PS2_OWNED].sort())
    assert.deepEqual(hashes(dir, PS2_OWNED), others)
    assert.equal(
      readFileSync(join(dir, 'BASLUS-20152AC04', 'BASLUS-20152AC04'), 'latin1'),
      'progress made on the other device'
    )
  })

  test('an archive carrying anything not the game’s is refused whole, and nothing moves', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const before = hashes(dir)
    const extras: FixtureTree[] = [
      { 'BASLUS-21693XX/BASLUS-21693XX': 'somebody else’s progress' },
      { _pcsx2_superblock: 'another card' },
      { 'BADATA-SYSTEM/history': 'another console’s history' },
      { 'BASLUS-20152.txt': 'a file at the root' }
    ]
    for (const extra of extras) {
      await assert.rejects(pull(dir, await remoteArchive({ ...REMOTE, ...extra })), /not this game/)
    }
    // A card holding none of the game's folders is refused too.
    await assert.rejects(
      pull(dir, await remoteArchive({ 'Mcd002.ps2/BASLUS-21693XX/x': 'not this game' })),
      /not this game/
    )
    // And so is an empty archive, rather than read as "delete everything". Built
    // by hand: the writer declines to make an archive of nothing.
    const empty = join(root, 'empty.zip')
    writeFileSync(empty, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'))
    await assert.rejects(pull(dir, empty), /not this game/)

    assert.deepEqual(hashes(dir), before)
    assert.equal(existsSync(join(root, 'backups')), false)
  })

  test('no copy can be kept, so nothing is replaced', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const before = hashes(dir)
    // A file where the backup folder should be: nothing can be copied into it.
    writeFileSync(join(root, 'backups'), 'in the way')
    await assert.rejects(pull(dir, await remoteArchive(REMOTE)), /could not keep a copy/)
    assert.deepEqual(hashes(dir), before)
  })

  test('a swap that cannot happen leaves the card as it was and the copies taken', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const before = hashes(dir)
    const archive = await remoteArchive(REMOTE)
    // The card can be read, so the copies are taken, but not written to.
    chmodSync(dir, 0o555)
    try {
      await assert.rejects(pull(dir, archive))
    } finally {
      chmodSync(dir, 0o755)
    }
    assert.deepEqual(hashes(dir), before)
    for (const member of PS2_OWNED) {
      assert.ok(existsSync(backupPath(join(root, 'backups'), join(dir, member), 1)))
    }
  })

  test('a swap that fails on the second folder puts the first one back too', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const before = hashes(dir)
    const move = async (from: string, to: string): Promise<void> => {
      if (from.includes('.part') && from.endsWith(`/${PS2_OWNED[1]}`)) {
        throw new Error('the disk said no')
      }
      await rename(from, to)
    }
    await assert.rejects(pull(dir, await remoteArchive(REMOTE), { move }), /the disk said no/)
    assert.deepEqual(hashes(dir), before)
    assert.deepEqual(readdirSync(root).sort(), ['backups', 'card'])
  })

  test('a swap that cannot be undone keeps the displaced folders rather than cleaning them away', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const move = async (from: string, to: string): Promise<void> => {
      const incoming = from.includes('.part') && from.endsWith(`/${PS2_OWNED[1]}`)
      const goingBack = from.includes('.old') && from.endsWith(`/${PS2_OWNED[0]}`)
      if (incoming || goingBack) throw new Error('the disk said no')
      await rename(from, to)
    }
    await assert.rejects(pull(dir, await remoteArchive(REMOTE), { move }))
    const kept = readdirSync(root).find((name) => name.endsWith('.old'))
    assert.ok(kept, 'the displaced copies are still beside the card')
    assert.equal(
      readFileSync(join(root, kept, PS2_OWNED[0], 'BASLUS-20152AC04'), 'latin1'),
      PS2_CARD['BASLUS-20152AC04/BASLUS-20152AC04']
    )
  })

  test('the next pull keeps what a swap that could not be undone left aside', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const move = async (from: string, to: string): Promise<void> => {
      const incoming = from.includes('.part') && from.endsWith(`/${PS2_OWNED[1]}`)
      const goingBack = from.includes('.old') && from.endsWith(`/${PS2_OWNED[0]}`)
      if (incoming || goingBack) throw new Error('the disk said no')
      await rename(from, to)
    }
    await assert.rejects(pull(dir, await remoteArchive(REMOTE), { move }))
    const left = readdirSync(root).find((name) => name.endsWith('.old'))
    assert.ok(left)

    await pull(dir, await remoteArchive(REMOTE))
    const kept = readdirSync(root).filter((name) => name.startsWith(`${left}-`))
    assert.equal(kept.length, 1)
    assert.equal(
      readFileSync(join(root, kept[0], PS2_OWNED[0], 'BASLUS-20152AC04'), 'latin1'),
      PS2_CARD['BASLUS-20152AC04/BASLUS-20152AC04']
    )
  })

  test('copies rotate per folder rather than piling up', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    for (let pulls = 0; pulls < 5; pulls += 1) await pull(dir, await remoteArchive(REMOTE))
    assert.deepEqual(readdirSync(join(root, 'backups')).sort(), [
      'BASLUS-20152AC04.1',
      'BASLUS-20152AC04.2',
      'BASLUS-20152AC04.3',
      'BASLUS-20152SYS.1',
      'BASLUS-20152SYS.2',
      'BASLUS-20152SYS.3'
    ])
  })

  test('a card PCSX2 has not made yet is made for the first pull', async () => {
    const dir = join(scratch(), 'memcards', 'Mcd001.ps2')
    await pull(dir, await remoteArchive(REMOTE))
    assert.deepEqual(readdirSync(dir).sort(), [...PS2_OWNED].sort())
  })
})

describe('deleting a game’s folders here', () => {
  test('only the game’s, each copied aside first', async () => {
    const root = scratch()
    const dir = join(root, 'card')
    plant(dir, PS2_CARD)
    const others = hashes(dir, PS2_OWNED)
    const backups = join(root, 'backups')

    assert.deepEqual(await removeUnit(dir, unit(), backups), [...PS2_OWNED].sort())
    assert.deepEqual(hashes(dir), others)
    for (const member of PS2_OWNED) assert.ok(existsSync(backupPath(backups, join(dir, member), 1)))
  })
})
