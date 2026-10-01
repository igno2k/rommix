import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { en } from '@shared/i18n/en.ts'
import { atHome, startApp, type App } from './driver.ts'
import { fakeRetroDeck, type FakeRetroDeck } from './retrodeck.ts'
import { startFakeRomm, type FakeRomm } from './server.ts'

/**
 * The PCSX2 settings PS2 save sync depends on, as the pre-flight check shows
 * them: the card in slot 1 is a folder card, and PCSX2 manages it per game.
 *
 * Against the same stand-in RetroDECK as `ps2.test.ts`. In order: the machine
 * starts as RetroDECK ships, then each setting is put wrong behind RomMix's
 * back and the check is run again — which is how it goes wrong on a real
 * machine, and what the button beside the check is for.
 */

/** As RetroDECK ships it, the card folder named by its absolute path. */
const ini = (manage: boolean, saves = join(retrodeck.root, 'saves')): string =>
  `[EmuCore]\nMcdFolderAutoManage = ${manage}\n\n[Folders]\nMemoryCards = ${saves}/ps2/pcsx2/memcards\n\n[MemoryCards]\nSlot1_Filename = Mcd001.ps2\n`

const CARD_REASON = en['saveSetup.pcsx2CardIsFolder']
const MANAGE_REASON = en['saveSetup.pcsx2FolderAutoManage']

let server: FakeRomm
let retrodeck: FakeRetroDeck
let app: App

before(async () => {
  server = await startFakeRomm()
  retrodeck = fakeRetroDeck({
    card: { _pcsx2_superblock: 'PCSX2 folder card superblock' },
    ini: (saves) => ini(true, saves)
  })
  app = await startApp({ baseUrl: server.baseUrl, token: server.token, env: retrodeck.env })
  await atHome(app)
  await app.goTo('settings')
  await app.waitFor(`document.querySelector('[data-tab="system"]')`, 'the settings tabs')
  await app.choose('[data-tab="system"]')
})

after(async () => {
  await app?.stop()
  await server?.close().catch(() => undefined)
})

/** Run the pre-flight check again and wait for its answer. */
async function recheck(): Promise<void> {
  await app.choose('[data-action="recheck-system"]')
  await app.waitFor(
    `!document.querySelector('[data-action="recheck-system"]')?.disabled`,
    'the check to finish'
  )
}

const shows = (text: string): Promise<boolean> =>
  app.read<boolean>(`document.body.textContent.includes(${JSON.stringify(text)})`)

describe('the PCSX2 settings in the pre-flight check', () => {
  test('as RetroDECK ships them, nothing is said about them', async () => {
    await app.waitFor(`document.querySelector('[data-action="recheck-system"]')`, 'the check')
    await recheck()
    assert.equal(await shows(en['system.saveSetup']), false)
    assert.equal(await shows(CARD_REASON), false)
    // Said nothing because both were read and found right, not because
    // neither was read: the report the screen draws from has them.
    const report = await app.read<{ id: string; status: string }[]>(
      `(await window.rommix.system.diagnostics()).saveSetup`
    )
    assert.deepEqual(
      report.map(({ id, status }) => [id, status]),
      [
        ['pcsx2.folderAutoManage', 'ok'],
        ['pcsx2.cardIsFolder', 'ok']
      ]
    )
  })

  test('management turned off is shown, and cancelling the fix changes nothing', async () => {
    writeFileSync(retrodeck.ini, ini(false))
    await recheck()
    await app.waitFor(`document.querySelector('[data-action="fix-save-setup"]')`, 'the fix')
    assert.ok(await shows(MANAGE_REASON))
    assert.equal(await shows(CARD_REASON), false)

    await app.choose('[data-action="fix-save-setup"]')
    await app.choose('[data-action="cancel-save-setup"]')
    await app.waitFor(
      `!document.querySelector('[data-action="confirm-save-setup"]')`,
      'the dialog to go'
    )
    assert.equal(readFileSync(retrodeck.ini, 'utf8'), ini(false))
  })

  test('fixed once it is confirmed: the line is set, and the file copied first', async () => {
    await app.choose('[data-action="fix-save-setup"]')
    await app.choose('[data-action="confirm-save-setup"]')
    await app.waitFor(`!document.querySelector('[data-action="fix-save-setup"]')`, 'the item to go')

    assert.equal(readFileSync(retrodeck.ini, 'utf8'), ini(true))
    const copies = join(app.home, 'config', 'emulator-backups')
    assert.deepEqual(readdirSync(copies), ['PCSX2.ini.1'])
    assert.equal(readFileSync(join(copies, 'PCSX2.ini.1'), 'utf8'), ini(false))
  })

  test('and fixing it again changes nothing', async () => {
    const at = statSync(retrodeck.ini).mtimeMs
    await app.read(`window.rommix.system.fixSaveSetup('pcsx2.folderAutoManage')`)
    assert.equal(statSync(retrodeck.ini).mtimeMs, at)
    assert.deepEqual(readdirSync(join(app.home, 'config', 'emulator-backups')), ['PCSX2.ini.1'])
  })

  test('a single-file card in slot 1 is reported with the way to convert it, and left alone', async () => {
    renameSync(retrodeck.card, `${retrodeck.card}.folder`)
    writeFileSync(retrodeck.card, 'an 8 MB card image')
    await recheck()
    await app.waitFor(
      `document.body.textContent.includes(${JSON.stringify(CARD_REASON)})`,
      'the card warning'
    )
    assert.ok(CARD_REASON.includes('Convert'), CARD_REASON)
    // A person's to do: there is no button for it.
    assert.equal(
      await app.read<boolean>(`!!document.querySelector('[data-action="fix-save-setup"]')`),
      false
    )
    assert.equal(readFileSync(retrodeck.card, 'utf8'), 'an 8 MB card image')
    assert.ok(existsSync(join(`${retrodeck.card}.folder`, '_pcsx2_superblock')))
  })
})
