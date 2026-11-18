/**
 * 聊天接口协议。
 *
 * - claude：`POST {base}/messages`（Anthropic Messages 兼容，DeepSeek 扩展能力都在这里）
 * - completions：`POST {base}/chat/completions`（OpenAI Chat Completions）
 * - responses：`POST {base}/responses`（OpenAI Responses）
 *
 * Veloce 网关三种都支持，切换后请求地址、请求体与流式解析都会相应改变。
 */
export type ApiProtocol = 'claude' | 'completions' | 'responses'

export const DEFAULT_API_PROTOCOL: ApiProtocol = 'claude'

export const normalizeApiProtocol = (value: string | null | undefined): ApiProtocol =>
  value === 'completions' || value === 'responses' ? value : DEFAULT_API_PROTOCOL

let current: ApiProtocol = DEFAULT_API_PROTOCOL

export const getApiProtocol = (): ApiProtocol => current

export const applyApiProtocol = (value: string | null | undefined): void => {
  current = normalizeApiProtocol(value)
}
