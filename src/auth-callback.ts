import './app/theme.css'
import './app/global.css'
import { setupTheme } from './app/theme.js'
import { completeAuthorize } from './services/authorize.js'
import { translate } from './i18n/index.js'

/**
 * 浏览器 / PWA 的 Veloce 授权回调页。
 *
 * 站点把浏览器送回这里时只带 `state`（成功）或 `error=access_denied`（用户取消）。
 * 这一页用同一个 state 换取令牌、写进本机设置，然后跳回应用首页；令牌不会出现在
 * 任何跳转链接里。原生应用不经过这一页，而是走 `com.veloce.aiapp://auth/callback`
 * 深链，由 services/authorizeDeepLink.ts 处理。
 */

const root = document.getElementById('root') as HTMLElement

const render = (text: string, action: { label: string; href: string }) => {
  root.textContent = ''
  const wrapper = document.createElement('div')
  wrapper.style.cssText =
    'display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;height:100vh;padding:24px;text-align:center;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)'

  const message = document.createElement('div')
  message.textContent = text
  wrapper.appendChild(message)

  const link = document.createElement('a')
  link.href = action.href
  link.textContent = action.label
  link.style.cssText = 'color:var(--dsw-alias-brand-text);text-decoration:none'
  wrapper.appendChild(link)

  root.appendChild(wrapper)
}

const run = async () => {
  setupTheme()
  const outcome = await completeAuthorize(window.location.href)

  if (outcome.status === 'success') {
    window.location.replace('./index.html?authorize=success')
    return
  }
  if (outcome.status === 'denied') {
    window.location.replace('./index.html?authorize=denied')
    return
  }

  const message =
    outcome.status === 'expired'
      ? translate('authorizeCallbackExpired')
      : outcome.status === 'mismatch'
        ? translate('authorizeCallbackStateMismatch')
        : translate('authorizeExchangeFailed', { message: outcome.message })
  render(message, { label: translate('authorizeBackToApp'), href: './index.html' })
}

void run()
