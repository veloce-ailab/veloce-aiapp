/**
 * Veloce 令牌授权接入。
 *
 * 流程（与后端 docs/token-authorization.md 一致）：
 * 1. 用户在设置里填站点地址，点击授权；
 * 2. 本应用生成高熵 state，打开 `<站点>/authorize?state=&redirect_uri=&app_name=`；
 * 3. 用户在站点上选择或新建一个令牌并同意授权；
 * 4. 站点把用户送回回调地址，且只带 `state`：
 *    - 原生应用走自定义协议 `com.veloce.aiapp://auth/callback?state=…`，直接把应用拉回前台；
 *    - 浏览器/PWA 走应用内的 `auth-callback.html?state=…`；
 * 5. 回调里用同一个 state 向 `<站点>/api/oauth/token` 换取令牌，写入本机设置。
 */

import { Capacitor } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { setApiBaseUrl, setApiKey } from './settings.js'

/** 授权请求相关信息在 localStorage 中的键 */
const PENDING_KEY = 'chat-demo:veloce-authorize'
/** 未完成的授权请求 10 分钟后失效，避免回调拿到过期的 state */
const PENDING_TTL = 10 * 60 * 1000
/** 展示在站点授权页上的应用名 */
export const AUTHORIZE_APP_NAME = 'Veloce AI App'
/** 原生应用的授权回调协议；与 Android intent-filter、iOS CFBundleURLSchemes 保持一致 */
export const NATIVE_CALLBACK_URL = 'com.veloce.aiapp://auth/callback'

export interface PendingAuthorize {
  site: string
  state: string
  createdAt: number
}

export interface AuthorizeResult {
  token: string
  site: string
  /** 站点对应的兼容接口前缀，形如 https://example.com/v1 */
  apiBaseUrl: string
  name?: string
}

export type AuthorizeOutcome =
  | { status: 'success' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'mismatch' }
  | { status: 'failed'; message: string }

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时授权无法跨页面完成，交由调用方提示
  }
}

const isLoopback = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'

/**
 * 规范化用户输入的站点地址：允许省略协议（默认 https），
 * 只保留 origin，非回环地址必须使用 https。
 */
export const normalizeSiteUrl = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    return null
  }
  if (!url.hostname) {
    return null
  }
  return url.origin
}

/** 32 字节随机数的 base64url 编码（43 字符），符合服务端 state 规则 */
export const createAuthorizeState = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 浏览器/PWA 用的回调地址：应用内的静态页 */
export const authorizeCallbackUrl = (): string =>
  new URL('auth-callback.html', window.location.href).toString()

/**
 * 是否运行在原生壳里。
 * 除了 Capacitor 的桥接判断，再加一层 WebView 地址兜底：Android 的 https://localhost、
 * iOS 的 capacitor://localhost 一定来自应用内部的静态资源，据此避免在浏览器里才用
 * auth-callback.html、在应用里却错误地回到 localhost。
 */
export const isNativePlatform = (): boolean => {
  if (Capacitor.isNativePlatform()) {
    return true
  }
  const { protocol, hostname } = window.location
  if (protocol === 'capacitor:' || protocol === 'ionic:') {
    return true
  }
  return protocol === 'https:' && hostname === 'localhost'
}

/** 站点授权完成后把用户送回哪里 */
export const authorizeRedirectUri = (): string =>
  isNativePlatform() ? NATIVE_CALLBACK_URL : authorizeCallbackUrl()

/** 打开站点授权页：原生放进系统浏览器（Custom Tab），网页端直接当前页跳转 */
export const openAuthorizePage = async (url: string): Promise<void> => {
  if (isNativePlatform()) {
    try {
      await Browser.open({ url })
      return
    } catch {
      // 没有可用浏览器时退回应用内跳转
    }
  }
  window.location.assign(url)
}

export const buildAuthorizeUrl = (site: string, state: string, redirectUri: string): string => {
  const params = new URLSearchParams({
    state,
    redirect_uri: redirectUri,
    app_name: AUTHORIZE_APP_NAME,
  })
  return `${site}/authorize?${params.toString()}`
}

export const savePendingAuthorize = (pending: PendingAuthorize): void => {
  write(PENDING_KEY, JSON.stringify(pending))
}

export const readPendingAuthorize = (): PendingAuthorize | null => {
  const raw = read(PENDING_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PendingAuthorize>
    if (
      typeof parsed.site !== 'string' ||
      typeof parsed.state !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      Date.now() - parsed.createdAt > PENDING_TTL
    ) {
      clearPendingAuthorize()
      return null
    }
    return { site: parsed.site, state: parsed.state, createdAt: parsed.createdAt }
  } catch {
    clearPendingAuthorize()
    return null
  }
}

export const clearPendingAuthorize = (): void => {
  write(PENDING_KEY, null)
}

/** 站点地址对应的兼容接口前缀 */
export const apiBaseUrlForSite = (site: string): string => `${site}/v1`

/** 用 state 换取令牌；state 只能兑换一次 */
export const exchangeAuthorizeState = async (site: string, state: string): Promise<AuthorizeResult> => {
  const response = await fetch(`${site}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  })
  if (!response.ok) {
    let message = response.statusText || `HTTP ${response.status}`
    try {
      const body: unknown = await response.json()
      if (typeof body === 'object' && body !== null && typeof (body as { error?: string }).error === 'string') {
        message = (body as { error: string }).error
      }
    } catch {
      // 非 JSON 响应体直接使用状态文本
    }
    throw new Error(message)
  }
  const body = (await response.json()) as { token?: unknown; name?: unknown }
  if (typeof body.token !== 'string' || !body.token) {
    throw new Error('authorization response did not contain a token')
  }
  return {
    token: body.token,
    site,
    apiBaseUrl: apiBaseUrlForSite(site),
    name: typeof body.name === 'string' ? body.name : undefined,
  }
}

/**
 * 处理授权回调：网页回调页与原生深链共用同一段逻辑。
 * 校验 state 与本次请求一致后才兑换，成功即写入 API Key 与接口地址。
 */
export const completeAuthorize = async (redirectUrl: string): Promise<AuthorizeOutcome> => {
  let params: URLSearchParams
  try {
    params = new URL(redirectUrl).searchParams
  } catch {
    return { status: 'mismatch' }
  }

  if (params.get('error')) {
    clearPendingAuthorize()
    return { status: 'denied' }
  }

  const pending = readPendingAuthorize()
  if (!pending) {
    return { status: 'expired' }
  }

  const state = params.get('state') ?? ''
  if (!state || state !== pending.state) {
    clearPendingAuthorize()
    return { status: 'mismatch' }
  }

  try {
    const result = await exchangeAuthorizeState(pending.site, state)
    setApiBaseUrl(result.apiBaseUrl || apiBaseUrlForSite(pending.site))
    setApiKey(result.token)
    clearPendingAuthorize()
    return { status: 'success' }
  } catch (cause) {
    clearPendingAuthorize()
    return { status: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
  }
}
