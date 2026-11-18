import { isNativePlatform } from './authorize.js'

/** 构建时写入 <meta name="application-version"> 的版本号 */
export const appVersion = (): string =>
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? 'unknown'

/** 跑在原生壳里还是浏览器里（含具体平台） */
export const runtimeLabel = (): string => {
  if (!isNativePlatform()) {
    return 'web'
  }
  const capacitor = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor
  const platform = capacitor?.getPlatform?.()
  return platform && platform !== 'web' ? `native:${platform}` : 'native'
}

/**
 * 一行运行时信息（版本 / 原生还是网页 / 页面源），显示在设置里，
 * 用来确认装的是哪个构建、授权回调走的是深链还是网页。
 */
export const runtimeSummary = (): string => {
  const origin = window.location.origin
  return `v${appVersion()} · ${runtimeLabel()} · ${origin}`
}
