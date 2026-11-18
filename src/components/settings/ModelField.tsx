import { useEffect, useMemo, useState } from 'react'
import { Select, type SelectOption } from '../base/Select.js'
import { Button } from '../base/Button.js'
import { DEFAULT_CHAT_MODEL } from '../../services/api/types.js'
import { fetchModelIDs } from '../../services/api/models.js'
import { setModel, useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

/**
 * 模型选择：从当前接口地址的 GET /models 拉列表，也可以在下面直接填任意模型名。
 * 直连 DeepSeek 时默认 deepseek-flash；接入 Veloce 站点后就是站点提供的模型。
 */
export const ModelField = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const apiBaseUrl = useSettings((state) => state.apiBaseUrl)
  const saved = useSettings((state) => state.model)
  const current = saved || DEFAULT_CHAT_MODEL
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState(false)
  const [custom, setCustom] = useState('')

  useEffect(() => {
    if (!apiKey) {
      setModels([])
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setFailure(false)
    fetchModelIDs(apiKey, controller.signal)
      .then((ids) => {
        if (!controller.signal.aborted) {
          setModels(ids)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailure(true)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      })
    return () => controller.abort()
    // apiBaseUrl 变化表示换了站点，需要重新拉列表
  }, [apiKey, apiBaseUrl])

  const options = useMemo<SelectOption<string>[]>(() => {
    const values = models.includes(current) ? models : [current, ...models]
    return values.map((value) => ({ value, label: value }))
  }, [models, current])

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('modelLabel')}</div>
        <div className={styles.description}>
          {loading
            ? t('modelLoading')
            : failure
              ? t('modelLoadFailed')
              : models.length > 0
                ? t('modelAvailable', { count: models.length })
                : t('modelHint')}
        </div>
        <Select
          ariaLabel={t('modelLabel')}
          value={current}
          options={options}
          placeholder={t('modelPlaceholder')}
          onChange={(value) => setModel(value)}
        />
        <div className={styles.apiKeyInput}>
          <input
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={t('modelCustomPlaceholder')}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                if (custom.trim()) {
                  setModel(custom.trim())
                  setCustom('')
                }
              }
            }}
          />
        </div>
        <Button
          variant="outlined"
          size="s"
          disabled={!custom.trim()}
          onClick={() => {
            if (custom.trim()) {
              setModel(custom.trim())
              setCustom('')
            }
          }}
        >
          {t('modelUseCustom')}
        </Button>
      </div>
    </div>
  )
}
