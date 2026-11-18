import { getApiBaseUrl } from './baseUrl.js'
import { request } from './client.js'

/**
 * 读取站点可用的模型列表（OpenAI 兼容的 GET /models）。
 * 直连 DeepSeek 时是 deepseek-flash 等模型，接入 Veloce 站点时是该令牌被允许的模型。
 */
export const fetchModelIDs = async (apiKey: string, signal?: AbortSignal): Promise<string[]> => {
  const response = await request(`${getApiBaseUrl()}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  const body: unknown = await response.json()
  const ids = new Set<string>()

  const collect = (value: unknown) => {
    if (typeof value === 'string') {
      ids.add(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item)
      }
      return
    }
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      if (typeof record.id === 'string') {
        ids.add(record.id)
      } else if (typeof record.name === 'string') {
        ids.add(record.name)
      }
    }
  }

  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>
    // OpenAI / Veloce: { object: 'list', data: [{ id }] }；也兼容 { models: [...] } 与裸数组
    collect(record.data ?? record.models ?? body)
  }

  return [...ids].sort((a, b) => a.localeCompare(b))
}
