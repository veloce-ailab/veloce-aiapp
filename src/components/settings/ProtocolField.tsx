import { Select } from '../base/Select.js'
import { DEFAULT_API_PROTOCOL, type ApiProtocol } from '../../services/api/protocol.js'
import { setProtocol, useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

/**
 * 接口协议：Claude Messages（默认，支持搜索/附件等扩展）或 OpenAI 兼容的
 * Chat Completions、Responses。切换后请求地址与流式解析随之改变。
 */
export const ProtocolField = () => {
  const t = useTranslate()
  const saved = useSettings((state) => state.protocol)
  const current: ApiProtocol = saved ?? DEFAULT_API_PROTOCOL

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('protocolLabel')}</div>
        <div className={styles.description}>{t('protocolDescription')}</div>
        <Select
          ariaLabel={t('protocolLabel')}
          value={current}
          options={[
            { value: 'claude', label: t('protocolClaude') },
            { value: 'completions', label: t('protocolCompletions') },
            { value: 'responses', label: t('protocolResponses') },
          ]}
          onChange={(value) => setProtocol(value as ApiProtocol)}
        />
      </div>
    </div>
  )
}
