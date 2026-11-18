import { useState } from 'react'
import { Button } from '../base/Button.js'
import { setApiBaseUrl, useSettings } from '../../services/settings.js'
import {
  authorizeRedirectUri,
  buildAuthorizeUrl,
  createAuthorizeState,
  normalizeSiteUrl,
  openAuthorizePage,
  savePendingAuthorize,
} from '../../services/authorize.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

/**
 * 站点授权：填入 Veloce 站点地址后跳转授权页，用户选择或新建令牌，
 * 回调页用 state 换到令牌并自动填入 API Key（见 services/authorize.ts）。
 */
export const VeloceAuthorizeField = () => {
  const t = useTranslate()
  const apiBaseUrl = useSettings((state) => state.apiBaseUrl)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    const site = normalizeSiteUrl(value)
    if (!site) {
      setError(t('veloceSiteInvalid'))
      return
    }
    setError(null)
    const state = createAuthorizeState()
    savePendingAuthorize({ site, state, createdAt: Date.now() })
    // 打开站点的授权页；回调走深链（原生）或 auth-callback.html（网页）
    await openAuthorizePage(buildAuthorizeUrl(site, state, authorizeRedirectUri()))
  }

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('veloceSiteTitle')}</div>
        <div className={styles.description}>{t('veloceSiteDescription')}</div>
        <div className={styles.apiKeyInput}>
          <input
            type="url"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={t('veloceSitePlaceholder')}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                void start()
              }
            }}
          />
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}
        <div className={styles.apiKeyInput}>
          <Button variant="primary" size="m" block onClick={() => void start()}>
            {t('veloceAuthorizeAction')}
          </Button>
        </div>
        <div className={styles.description}>{t('veloceCallbackUrl', { url: authorizeRedirectUri() })}</div>
        <div className={styles.description}>
          {apiBaseUrl ? t('veloceCurrentSite', { url: apiBaseUrl }) : t('veloceDefaultSite')}
        </div>
        {apiBaseUrl ? (
          <Button variant="outlined" size="s" onClick={() => setApiBaseUrl(null)}>
            {t('veloceResetSite')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
