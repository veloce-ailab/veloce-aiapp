import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 原生壳配置：把 dist/ 里的静态聊天页装进 Android / iOS 应用。
 *
 * 站点的令牌授权回调地址是 `<应用内地址>/auth-callback.html`；WebView 的源是
 * https://localhost（Android）或 capacitor://localhost（iOS），两者都在 Veloce
 * 授权页允许的回调范围内，因此无需额外的自定义 scheme 注册。
 */
const config: CapacitorConfig = {
  appId: 'com.veloce.aiapp',
  appName: 'Veloce AI',
  webDir: 'dist',
  android: {
    // 站点是 https 时无需混合内容；本机 http://localhost 调试仍由 WebView 放行
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'always',
  },
}

export default config
