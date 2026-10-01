import { type JSX, useState } from 'react'
import type { SaveSetupItem } from '@shared/types'
import { FocusButton, Overlay } from '../../components'
import { useApp, useI18n } from '../../state'

/**
 * The emulator settings save sync depends on that are off, and a way to set
 * the ones RomMix may set.
 *
 * Nothing is listed when everything is as it should be. A fix is never made
 * from here directly: the button opens a dialog saying which file and which
 * key, and only its confirm button asks the main process, which checks again
 * and refuses while the emulator runs.
 */
export function SaveSetupPanel({
  items,
  onFixed
}: {
  items: readonly SaveSetupItem[]
  /** Run the pre-flight check again, these settings being part of it. */
  onFixed: () => Promise<unknown>
}): JSX.Element | null {
  const { t } = useI18n()
  const { notify } = useApp()
  const [asking, setAsking] = useState<SaveSetupItem | null>(null)
  const [fixing, setFixing] = useState(false)
  const off = items.filter((item) => item.status === 'off')
  if (off.length === 0) return null

  const fix = async (item: SaveSetupItem): Promise<void> => {
    setFixing(true)
    try {
      await window.rommix.system.fixSaveSetup(item.id)
      notify(t('system.saveSetupFixed'), 'ok')
      await onFixed()
    } catch {
      // Reported centrally on `app:error`, refusals included.
    } finally {
      setFixing(false)
      setAsking(null)
    }
  }

  return (
    <>
      <h2 className="section-title">{t('system.saveSetup')}</h2>
      {off.map((item) => (
        <div className="notice notice--warn" key={item.id}>
          <div>{item.reason}</div>
          <div className="faint">
            {t('system.saveSetupSetting', {
              key: item.key,
              file: item.file,
              found: item.found ?? t('system.saveSetupUnset')
            })}
          </div>
          {item.wanted !== null ? (
            <div className="btn-row">
              <FocusButton
                icon="confirm"
                action="fix-save-setup"
                disabled={fixing}
                onSelect={() => setAsking(item)}
              >
                {t('system.saveSetupFix')}
              </FocusButton>
            </div>
          ) : null}
        </div>
      ))}

      {asking ? (
        <Overlay
          title={t('system.saveSetupConfirmTitle')}
          icon="warn"
          onDismiss={() => setAsking(null)}
        >
          <p className="muted">
            {t('system.saveSetupConfirmBody', {
              key: asking.key,
              wanted: asking.wanted ?? '',
              file: asking.file
            })}
          </p>
          <div className="btn-row">
            <FocusButton
              icon="confirm"
              action="confirm-save-setup"
              variant="primary"
              disabled={fixing}
              onSelect={() => void fix(asking)}
              autoFocus
            >
              {t('system.saveSetupConfirm')}
            </FocusButton>
            <FocusButton
              icon="cancel"
              action="cancel-save-setup"
              variant="ghost"
              onSelect={() => setAsking(null)}
            >
              {t('action.cancel')}
            </FocusButton>
          </div>
        </Overlay>
      ) : null}
    </>
  )
}
