import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYNC_TOLERANCE_MS } from '../../src/main/savefiles.ts'
import { zipMembers, zipRoots } from '../../src/main/zip.ts'
import { atHome, startApp, type App } from './driver.ts'
import { fakeRetroDeck, hashes, plant, type FakeRetroDeck, type Tree } from './retrodeck.ts'
import { startFakeRomm, type FakeRomm } from './server.ts'

/**
 * A PS2 game's saves on RetroDECK's PCSX2 folder card, from the pull before
 * the game starts to the push after it ends.
 *
 * RetroDECK here is a home directory and a `flatpak` script — see
 * `fakeRetroDeck` — and the card is a folder with two games on it, the
 * console's own folder and PCSX2's files. What every scenario comes back to is
 * the other game: a pull or a push that touched anything on the card that is
 * not this game's is the failure that matters, so it is asserted as a hash of
 * everything else, before and after.
 *
 * In order, like `games.test.ts`: the save the pull brings down is the one the
 * session changes, and the session is what the push sends.
 */

const ROM = 6
/** The folders `SLUS-20152` writes, which are the game's on the card. */
const OWNED = ['BASLUS-20152AC04', 'BASLUS-20152SYS']
const PROGRESS = 'BASLUS-20152AC04/BASLUS-20152AC04'

const CARD: Tree = {
  _pcsx2_superblock: 'PCSX2 folder card superblock',
  _pcsx2_index: 'the card root index',
  'BASLUS-20152AC04/BASLUS-20152AC04': 'progress on this device',
  'BASLUS-20152AC04/icon.sys': 'icon',
  'BASLUS-20152AC04/_pcsx2_index': 'the index PCSX2 keeps on this device',
  'BASLUS-20152SYS/settings': 'settings on this device',
  'BASLUS-21693XX/BASLUS-21693XX': 'another game',
  'BADATA-SYSTEM/history': 'the console history'
}

/**
 * The raw directory entry PCSX2 keeps beside a save whose mode a host file
 * cannot carry — a copy-protected save. Part of the save, carried as it is.
 */
const META = Buffer.alloc(0x200)
META.writeUInt16LE(0x842f, 0)

/** The game's folders as another device zipped them: Argosy's shape, no index. */
const REMOTE: Tree = {
  'BASLUS-20152AC04/BASLUS-20152AC04': 'progress from another device',
  'BASLUS-20152AC04/icon.sys': 'icon',
  'BASLUS-20152SYS/settings': 'settings from another device',
  'BASLUS-20152SYS/_pcsx2_meta_directory': META
}

/** As RetroDECK ships it, the card folder named by its absolute path. */
const INI = (saves: string): string =>
  `[EmuCore]\nMcdFolderAutoManage = true\n\n[Folders]\nMemoryCards = ${saves}/ps2/pcsx2/memcards\n\n[MemoryCards]\nSlot1_Filename = Mcd001.ps2\n`

async function zipOf(tree: Tree): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'rommix-ps2-zip-'))
  plant(join(dir, 'files'), tree)
  const roots = [...new Set(Object.keys(tree).map((path) => path.split('/')[0]))]
  await zipMembers(join(dir, 'files'), roots, join(dir, 'unit.zip'))
  return readFileSync(join(dir, 'unit.zip'))
}

/** The file part of a multipart upload, as the bytes that were sent. */
function filePart(body: Buffer): Buffer {
  const boundary = body.subarray(0, body.indexOf('\r\n')).toString()
  const start = body.indexOf('\r\n\r\n', body.indexOf('filename=')) + 4
  return body.subarray(start, body.indexOf(`\r\n${boundary}`, start))
}

let server: FakeRomm
let retrodeck: FakeRetroDeck
let app: App
let others: Record<string, string>

before(async () => {
  server = await startFakeRomm({ ps2: true })
  server.holdSave({
    romId: ROM,
    fileName: 'Jak and Daxter.zip',
    emulator: 'pcsx2',
    slot: 'autosave',
    content: await zipOf(REMOTE)
  })
  retrodeck = fakeRetroDeck({ card: CARD, ini: INI })
  retrodeck.session({ path: PROGRESS, content: 'progress from this session' })
  others = hashes(retrodeck.card, OWNED)
  app = await startApp({
    baseUrl: server.baseUrl,
    token: server.token,
    settings: { systemEmulators: { ps2: 'retrodeck' }, confirmSavePush: false },
    env: retrodeck.env
  })
  await atHome(app)
})

after(async () => {
  await app?.stop()
  await server?.close().catch(() => undefined)
})

/** Download the game where it has not been yet, and press Play. */
async function play(): Promise<void> {
  await app.goTo('library')
  await app.choose(`[data-rom="${ROM}"]`)
  await app.waitFor(`document.querySelector('[data-screen="game"]')`, 'the game screen')
  const installed = `(await window.rommix.library.installed()).some((one) => one.romId === ${ROM})`
  if (!(await app.read<boolean>(installed))) {
    await app.choose('[data-action="download"]')
    await app.waitFor(installed, 'the game to arrive')
  }
  await app.choose('[data-action="play"]')
}

/** Wait out the session, which ends when the stand-in does. */
async function sessionOver(): Promise<void> {
  await app.waitFor(`!document.querySelector('.curtain, .overlay')`, 'the session to end', 45_000)
}

describe('a PS2 game on the folder card', () => {
  test("the server's copy is in the game's folders before the game starts", async () => {
    await play()
    // Asked of the stand-in, which wrote down what it found before writing
    // anything of its own — the only account of that moment the session
    // cannot have overwritten.
    assert.equal(await retrodeck.found(), 'progress from another device')
    assert.equal(
      readFileSync(join(retrodeck.card, 'BASLUS-20152SYS/settings'), 'utf8'),
      'settings from another device'
    )
    // A copy-protected save's metadata is part of it, and arrives as it was.
    assert.deepEqual(
      readFileSync(join(retrodeck.card, 'BASLUS-20152SYS/_pcsx2_meta_directory')),
      META
    )
  })

  test('nothing else on the card changed, and what only this device had stays', async () => {
    assert.deepEqual(hashes(retrodeck.card, OWNED), others)
    // The archive carried no index, and Argosy leaves the one here in place.
    assert.equal(
      readFileSync(join(retrodeck.card, 'BASLUS-20152AC04/_pcsx2_index'), 'utf8'),
      'the index PCSX2 keeps on this device'
    )
  })

  test('every folder the pull wrote into was copied aside first', async () => {
    const copy = join(app.home, 'saves', String(ROM), 'BASLUS-20152AC04.1')
    assert.equal(readFileSync(join(copy, 'BASLUS-20152AC04'), 'utf8'), 'progress on this device')
    assert.ok(existsSync(join(app.home, 'saves', String(ROM), 'BASLUS-20152SYS.1')))
  })

  test("what the session wrote goes up as the game's folders, and only those", async () => {
    await sessionOver()
    const sent = server.uploaded.filter((one) => one.kind === 'save' && one.romId === ROM)
    assert.equal(sent.length, 1, `uploads: ${JSON.stringify(sent.map((one) => one.slot))}`)
    assert.equal(sent[0].emulator, 'pcsx2')
    assert.equal(sent[0].slot, 'autosave')

    const archive = join(mkdtempSync(join(tmpdir(), 'rommix-ps2-sent-')), 'sent.zip')
    writeFileSync(archive, filePart(sent[0].bytes))
    const roots = (await zipRoots(archive)).map((root) => root.name).sort()
    assert.deepEqual(roots, OWNED)
    assert.deepEqual((await zipRoots(archive, 'BASLUS-20152AC04')).map((one) => one.name).sort(), [
      'BASLUS-20152AC04',
      '_pcsx2_index',
      'icon.sys'
    ])
    assert.equal(readFileSync(join(retrodeck.card, PROGRESS), 'utf8'), 'progress from this session')
    assert.deepEqual(hashes(retrodeck.card, OWNED), others)
  })

  test('a session that saved nothing sends nothing', async () => {
    retrodeck.session(null)
    const sentSoFar = server.uploaded.length
    // Started again only once the last push is out of the clock tolerance a
    // push allows the session's start. Within it, the last session's stamp
    // reads as this one's; nobody quits a game and starts it again that quickly.
    await new Promise((resolve) => setTimeout(resolve, SYNC_TOLERANCE_MS + 1000))
    await play()
    await app.waitFor(`document.querySelector('.curtain, .overlay')`, 'the session to start')
    // Over only once the push after it is: `Launcher` pushes before it reports.
    await sessionOver()
    assert.equal(server.uploaded.length, sentSoFar, 'nothing changed, so nothing should go up')
    assert.equal(readFileSync(join(retrodeck.card, PROGRESS), 'utf8'), 'progress from this session')
  })
})
