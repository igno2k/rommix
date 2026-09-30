import { type JSX, useState } from 'react'
import type { SaveSetupItem, SaveSetupReport } from '@shared/types'
import { FocusButton, Overlay } from '../../components'
import { useApp, useI18n } from '../../state'

/**
 * The emulator settings save sync depends on, and a way to set the ones that
 * are off.
 *
 * Only what is off is listed: a panel of twenty settings that are all fine
 * hides the one that is not. A fix is never made from here directly — the
 * button opens a dialog saying which file and which key, and only its confirm
 * button asks the main process, which checks again and refuses while the
 * emulator runs.
 */
export function SaveSetupPanel({
  report,
  onFixed
}: {
  report: SaveSetupReport
  /** Run the pre-flight check again, the report being part of it. */
  onFixed: () => Promise<unknown>
}): JSX.Element {
  const { t } = useI18n()
  const { notify } = useApp()
  const [asking, setAsking] = useState<SaveSetupItem | null>(null)
  const [fixing, setFixing] = useState(false)
  const off = report.items.filter((item) => item.status !== 'ok')

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

  const detail = (item: SaveSetupItem): string => {
    if (item.status === 'missing-file') return t('system.saveSetupMissing', { file: item.file })
    if (item.status === 'unreadable') return t('system.saveSetupUnreadable', { file: item.file })
    return t('system.saveSetupSetting', {
      key: item.key,
      file: item.file,
      found: item.found ?? t('system.saveSetupUnset'),
      wanted: item.wanted
    })
  }

  return (
    <>
      <h2 className="section-title">{t('system.saveSetup')}</h2>
      <p className="faint" style={{ fontSize: 14 }}>
        {t('system.saveSetupExplainer')}
      </p>
      {off.length === 0 ? (
        <div className="notice notice--ok">{t('system.saveSetupAllOk')}</div>
      ) : (
        off.map((item) => (
          <div className="notice notice--warn" key={item.id} data-save-setup={item.id}>
            <div>{item.reason}</div>
            <div className="faint">{detail(item)}</div>
            {item.status === 'drift' && item.fix === 'edit' ? (
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
        ))
      )}

      {asking ? (
        <Overlay
          title={t('system.saveSetupConfirmTitle')}
          icon="warn"
          onDismiss={() => setAsking(null)}
        >
          <p className="muted">
            {t('system.saveSetupConfirmBody', {
              key: asking.key,
              wanted: asking.wanted,
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
