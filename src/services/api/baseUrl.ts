/**
 * 运行时 API 基地址。
 *
 * 默认使用构建期注入的 __API_ORIGIN__（DeepSeek 兼容的 /anthropic/v1 前缀）；
 * 通过 Veloce 授权接入后，改为站点地址 + /v1，例如 https://veloce.example.com/v1。
 * 之所以放在独立模块里，是为了让 settings、client、speech 都能读取而不会互相循环依赖。
 */

/** 构建期默认值：Anthropic 兼容接口前缀 */
export const DEFAULT_API_BASE_URL = `${__API_ORIGIN__}/anthropic/v1`

/** 去掉结尾斜杠；空值回落到默认地址 */
export const normalizeApiBaseUrl = (value: string | null | undefined): string => {
  const trimmed = (value ?? '').trim()
  if (!trimmed) {
    return DEFAULT_API_BASE_URL
  }
  return trimmed.replace(/\/+$/, '')
}

let current = DEFAULT_API_BASE_URL

/** 当前生效的 API 基地址（不带结尾斜杠） */
export const getApiBaseUrl = (): string => current

/** 更新运行时 API 基地址；传 null 表示回到构建期默认值 */
export const applyApiBaseUrl = (value: string | null | undefined): void => {
  current = normalizeApiBaseUrl(value)
}
