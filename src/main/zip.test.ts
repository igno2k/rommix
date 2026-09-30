import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PS2_CARD, PS2_OWNED, type FixtureTree } from '@config/emulators/units/fixtures.ts'
import {
  extractZip,
  isZip,
  membersContentHash,
  zipContentHash,
  zipDirectory,
  zipMembers,
  zipRoots
} from './zip.ts'

/**
 * The zip writer, round-tripped.
 *
 * RomMix emits zip archives by hand — eighty lines of local headers, a central
 * directory and a CRC table — rather than taking a dependency to produce a
 * format that has not changed since 1993. That is a reasonable trade only while
 * the output is genuinely a zip, and "genuinely" is not something the type
 * checker has an opinion about: a wrong CRC, a miscounted central-directory
 * offset or a bad length field all produce a file that is exactly the right
 * size and that no unzip will open.
 *
 * So these tests read the archive back with `extractZip` *and*, where the tool
 * is present, check it against the system `unzip`. Reading it back with the
 * matching reader would pass happily on two halves of the same misunderstanding.
 *
 * What is at stake: a Switch save is a directory, and this is how one reaches
 * RomM. An archive the server accepts and nothing can open is a save the user
 * believes is backed up.
 */

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rommix-zip-test-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** Is the system `unzip` available to check our work against? */
function haveUnzip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('an archive round-trips through extractZip with its contents intact', async () => {
  const root = scratch()
  const source = join(root, 'save')
  mkdirSync(join(source, 'nested'), { recursive: true })

  // Deliberately awkward: a file large enough to actually compress, a nested
  // path, a name outside ASCII, and an empty file — the last being the one that
  // a length field written from the wrong variable gets wrong.
  const bulk = Buffer.alloc(5000, 7)
  writeFileSync(join(source, 'game.dat'), bulk)
  writeFileSync(join(source, 'nested', 'ünïcode — save.dat'), 'ünïcode ✓')
  writeFileSync(join(source, 'empty.dat'), '')

  const zipPath = join(root, 'out.zip')
  assert.equal(await zipDirectory(source, zipPath), 3)
  assert.equal(await isZip(zipPath), true)

  const back = join(root, 'back')
  await extractZip(zipPath, back)

  assert.deepEqual(readFileSync(join(back, 'game.dat')), bulk)
  assert.equal(readFileSync(join(back, 'nested', 'ünïcode — save.dat'), 'utf8'), 'ünïcode ✓')
  assert.equal(readFileSync(join(back, 'empty.dat')).length, 0)
})

test('the archive is one a different implementation can open', { skip: !haveUnzip() }, async () => {
  const root = scratch()
  const source = join(root, 'save')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'a.dat'), Buffer.alloc(4096, 3))
  writeFileSync(join(source, 'b.dat'), 'plain text')

  const zipPath = join(root, 'out.zip')
  await zipDirectory(source, zipPath)

  // `unzip -t` verifies every entry's CRC against its decompressed bytes, which
  // is the check our own reader cannot make on its own behalf.
  const report = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' })
  assert.match(report, /No errors detected/)
})

test('the directory itself is not a level in the archive', async () => {
  // Entries are named relative to the folder, so a Switch save restored on
  // another device lands in that device's profile folder rather than nesting a
  // copy of the original profile id inside it.
  const root = scratch()
  const source = join(root, '0123456789abcdef')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'slot.dat'), 'x')

  const zipPath = join(root, 'out.zip')
  await zipDirectory(source, zipPath)
  const back = join(root, 'somewhere-else')
  await extractZip(zipPath, back)

  assert.equal(readFileSync(join(back, 'slot.dat'), 'utf8'), 'x')
})

test('an empty folder produces no archive, so an empty save is not uploaded', async () => {
  const root = scratch()
  const source = join(root, 'save')
  mkdirSync(source, { recursive: true })
  assert.equal(await zipDirectory(source, join(root, 'out.zip')), 0)
})

/**
 * Every shape of escaping entry, and what actually happens to it.
 *
 * Built by hand: `zipDirectory` cannot produce one of these, and the case that
 * matters is an archive from somewhere else. RomM serves the ROM zips RomMix
 * unpacks, so this guard stands between a compromised or simply corrupt server
 * and the user's home directory.
 *
 * The extraction *rejects* rather than skipping the entry — yauzl validates
 * names as it reads the central directory and aborts the whole archive, which
 * is stricter than RomMix's own `safeJoin` and gets there first. Asserted as
 * rejection because that is the real behaviour; the caller treats a failed
 * extraction as a failed download and cleans up after it.
 */
for (const name of ['../escaped.txt', '/etc/rommix-escaped', 'a/../../escaped.txt']) {
  test(`a zip entry named ${name} cannot escape the destination`, async () => {
    const root = scratch()
    const dest = join(root, 'dest')
    mkdirSync(dest, { recursive: true })

    const evil = join(root, 'evil.zip')
    writeFileSync(evil, traversingZip(name, 'pwned'))

    await assert.rejects(() => extractZip(evil, dest))
    assert.equal(await exists(join(root, 'escaped.txt')), false, 'nothing written beside dest')
    assert.equal(await exists(join(dest, 'escaped.txt')), false, 'and nothing smuggled inside')
  })
}

test('a file that is not a zip is not mistaken for one', async () => {
  const root = scratch()
  const rom = join(root, 'game.sfc')
  // A ROM download is only unpacked when it really is an archive; a bare ROM
  // whose first bytes happened to be tested as text must not be.
  writeFileSync(rom, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))
  assert.equal(await isZip(rom), false)
  assert.equal(await isZip(join(root, 'missing.zip')), false)
})

async function exists(path: string): Promise<boolean> {
  const { access } = await import('node:fs/promises')
  return access(path).then(
    () => true,
    () => false
  )
}

/**
 * A one-entry stored (uncompressed) zip whose entry name is whatever is given.
 *
 * Hand-assembled because the point is to produce something our own writer never
 * would. Stored rather than deflated so the two length fields are the same
 * number and the fixture stays readable.
 */
function traversingZip(name: string, contents: string): Buffer {
  const data = Buffer.from(contents, 'utf8')
  const nameBytes = Buffer.from(name, 'utf8')
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8) // stored
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 10) // stored
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt32LE(0, 42)

  const centralStart = local.length + nameBytes.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + nameBytes.length, 12)
  end.writeUInt32LE(centralStart, 16)

  return Buffer.concat([local, nameBytes, data, central, nameBytes, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

test('a save folder with subdirectories keeps its shape through the round trip', async () => {
  // A Switch save is a tree, not a flat list, and the paths inside the archive
  // are what put each file back where the emulator expects it.
  const dir = scratch()
  const source = join(dir, 'save')
  mkdirSync(join(source, 'user', '0001'), { recursive: true })
  writeFileSync(join(source, 'user', '0001', 'data.bin'), 'deep')
  writeFileSync(join(source, 'top.bin'), 'shallow')

  const archive = join(dir, 'save.zip')
  const count = await zipDirectory(source, archive)
  assert.equal(count, 2)

  const back = join(dir, 'back')
  await extractZip(archive, back)
  assert.equal(readFileSync(join(back, 'user', '0001', 'data.bin'), 'utf8'), 'deep')
  assert.equal(readFileSync(join(back, 'top.bin'), 'utf8'), 'shallow')
})

test('a directory that is not there produces no archive rather than an error', async () => {
  // A save folder the emulator has not created yet is an ordinary state, and
  // the push has to treat it as "nothing to send".
  const dir = scratch()

  assert.equal(await zipDirectory(join(dir, 'never-created'), join(dir, 'out.zip')), 0)
})

test('a symlink to a folder is followed, and one to nowhere is left out', async () => {
  // EmuDeck links each emulator's own save directory into its Emulation tree,
  // so a save folder really is a symlink on the machines this runs on.
  const dir = scratch()
  const source = join(dir, 'save')
  const real = join(dir, 'elsewhere')
  mkdirSync(source, { recursive: true })
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'linked.bin'), 'through the link')
  symlinkSync(real, join(source, 'sub'))
  symlinkSync(join(dir, 'gone'), join(source, 'broken'))

  const archive = join(dir, 'save.zip')
  const count = await zipDirectory(source, archive)

  const back = join(dir, 'back')
  await extractZip(archive, back)
  assert.equal(readFileSync(join(back, 'sub', 'linked.bin'), 'utf8'), 'through the link')
  // The broken link is counted as a file and skipped when it cannot be read,
  // rather than aborting an upload that is mostly fine.
  assert.ok(count >= 1)
})

test('an archive that is not a zip at all is refused, not half-extracted', async () => {
  const dir = scratch()
  const notAnArchive = join(dir, 'rom.md')
  writeFileSync(notAnArchive, 'plain bytes, definitely not a zip')

  await assert.rejects(() => extractZip(notAnArchive, join(dir, 'out')))
})

test('a file too short to have a signature is not a zip', async () => {
  const dir = scratch()
  const tiny = join(dir, 'tiny')
  writeFileSync(tiny, 'PK')

  assert.equal(await isZip(tiny), false)
  assert.equal(await isZip(join(dir, 'not-there-at-all')), false)
})

/** Write a fixture tree under `root`, contents as latin1 bytes. */
function plant(root: string, tree: FixtureTree): void {
  for (const [relative, contents] of Object.entries(tree)) {
    mkdirSync(join(root, relative, '..'), { recursive: true })
    writeFileSync(join(root, relative), Buffer.from(contents, 'latin1'))
  }
}

test('a game\u2019s members are the roots of the archive, and nothing else of the folder is in it', async () => {
  const root = scratch()
  const card = join(root, 'Mcd001.ps2')
  plant(card, PS2_CARD)

  const zipPath = join(root, 'unit.zip')
  assert.equal(await zipMembers(card, PS2_OWNED, zipPath), 4)

  // Argosy's shape: each save folder a root, the card's own name and its
  // superblock nowhere.
  assert.deepEqual(
    (await zipRoots(zipPath)).sort((a, b) => (a.name < b.name ? -1 : 1)),
    [
      { name: 'BASLUS-20152AC04', kind: 'dir' },
      { name: 'BASLUS-20152SYS', kind: 'dir' }
    ]
  )
  const back = join(root, 'back')
  await extractZip(zipPath, back)
  assert.equal(
    readFileSync(join(back, 'BASLUS-20152SYS', 'settings'), 'latin1'),
    PS2_CARD['BASLUS-20152SYS/settings']
  )
})

test('a file member is a root file of its own', async () => {
  const root = scratch()
  writeFileSync(join(root, '01-GZLE-a.gci'), 'first')
  writeFileSync(join(root, '01-GZLE-b.gci'), 'second')
  writeFileSync(join(root, '8P-GM4E-c.gci'), 'not asked for')

  const zipPath = join(root, 'out', 'unit.zip')
  assert.equal(await zipMembers(root, ['01-GZLE-b.gci', '01-GZLE-a.gci', 'gone.gci'], zipPath), 2)
  assert.deepEqual(await zipRoots(zipPath), [
    { name: '01-GZLE-a.gci', kind: 'file' },
    { name: '01-GZLE-b.gci', kind: 'file' }
  ])
})

test('the same files make the same bytes, whenever and in whatever order they were listed', async () => {
  // RomM files a slot upload by its md5, so two devices pushing one unchanged
  // save must send one archive.
  const one = scratch()
  const other = scratch()
  plant(join(one, 'card'), PS2_CARD)
  plant(join(other, 'card'), PS2_CARD)
  const later = new Date('2030-01-01T00:00:00Z')
  utimesSync(join(other, 'card', 'BASLUS-20152SYS', 'settings'), later, later)

  await zipMembers(join(one, 'card'), PS2_OWNED, join(one, 'a.zip'))
  await zipMembers(join(other, 'card'), PS2_OWNED.toReversed(), join(other, 'b.zip'))

  assert.deepEqual(readFileSync(join(one, 'a.zip')), readFileSync(join(other, 'b.zip')))
})

test('no member left to archive writes nothing', async () => {
  const root = scratch()
  mkdirSync(join(root, 'EMPTYDIR'))
  assert.equal(await zipMembers(root, ['EMPTYDIR', 'missing'], join(root, 'none.zip')), 0)
})

test('the roots of an archive another client wrote are read the same way', async () => {
  const root = scratch()
  const source = join(root, 'src')
  plant(source, {
    'CARD/BASLUS-20152AC04/icon.sys': 'x',
    'CARD/_pcsx2_superblock': 'y',
    'loose.bin': 'z'
  })
  const zipPath = join(root, 'legacy.zip')
  await zipDirectory(source, zipPath)

  assert.deepEqual(await zipRoots(zipPath), [
    { name: 'CARD', kind: 'dir' },
    { name: 'loose.bin', kind: 'file' }
  ])
})

test('an archive that cannot be read has no roots to offer, and says so', async () => {
  const root = scratch()
  writeFileSync(join(root, 'bad.zip'), 'not a zip')
  await assert.rejects(zipRoots(join(root, 'bad.zip')))
})

test(
  'the members archive opens in a different implementation too',
  { skip: !haveUnzip() },
  async () => {
    const root = scratch()
    plant(join(root, 'card'), PS2_CARD)
    const zipPath = join(root, 'unit.zip')
    await zipMembers(join(root, 'card'), PS2_OWNED, zipPath)
    const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n')
    assert.deepEqual(listing, [
      'BASLUS-20152AC04/BASLUS-20152AC04',
      'BASLUS-20152AC04/icon.sys',
      'BASLUS-20152SYS/icon.sys',
      'BASLUS-20152SYS/settings'
    ])
  }
)

/**
 * What RomM records as `content_hash` for the fixture card's two save folders,
 * zipped here — computed by RomM's own `hash_zip_contents`, run with Python's
 * `zipfile` over the archive `zipMembers` writes. Pinned, so a change to either
 * side of the transcription fails here rather than as every pull refused.
 */
const ROMM_CONTENT_HASH = '9451d2d60d9692b2abaa142eb0764ea5'

test('an archive hashes the way RomM hashes it, by what is in it', async () => {
  const root = scratch()
  plant(join(root, 'card'), PS2_CARD)
  const zipPath = join(root, 'unit.zip')
  await zipMembers(join(root, 'card'), PS2_OWNED, zipPath)

  assert.equal(await zipContentHash(zipPath), ROMM_CONTENT_HASH)
  // And the files on the disk to the same, without an archive being made.
  assert.equal(await membersContentHash(join(root, 'card'), PS2_OWNED), ROMM_CONTENT_HASH)
})

/** Is the system `zip` there, to write an archive some other way than RomMix does? */
function haveZip(): boolean {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('the content hash ignores how an archive was made', { skip: !haveZip() }, async () => {
  const root = scratch()
  plant(join(root, 'CARD'), { 'a/one': '1', 'b/two': '2' })
  await zipDirectory(join(root, 'CARD'), join(root, 'mine.zip'))
  // Another writer's archive, with its folder entries, which do not count.
  const other = join(root, 'other.zip')
  execFileSync('zip', ['-q', '-r', '-9', other, 'b', 'a'], { cwd: join(root, 'CARD') })
  assert.equal(await zipContentHash(other), await zipContentHash(join(root, 'mine.zip')))
})

test('the content hash follows what is in the files', async () => {
  const root = scratch()
  plant(join(root, 'CARD'), { 'a/one': '1', 'b/two': '2' })
  await zipDirectory(join(root, 'CARD'), join(root, 'mine.zip'))
  assert.equal(
    await membersContentHash(join(root, 'CARD'), ['a', 'b']),
    await zipContentHash(join(root, 'mine.zip'))
  )

  writeFileSync(join(root, 'CARD', 'a', 'one'), 'changed')
  assert.notEqual(
    await membersContentHash(join(root, 'CARD'), ['a', 'b']),
    await zipContentHash(join(root, 'mine.zip'))
  )
  assert.equal(await membersContentHash(join(root, 'CARD'), ['none']), null)
})
