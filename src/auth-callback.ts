import './app/theme.css'
import './app/global.css'
import { setupTheme } from './app/theme.js'
import { setApiBaseUrl, setApiKey } from './services/settings.js'
import {
  apiBaseUrlForSite,
  clearPendingAuthorize,
  exchangeAuthorizeState,
  readPendingAuthorize,
} from './services/authorize.js'
import { translate } from './i18n/index.js'

/**
 * Veloce 授权的回调页。
 *
 * 站点把浏览器送回这里时只带 `state`（成功）或 `error=access_denied`（用户取消）。
 * 这个页面用同一个 state 向站点换取令牌，写进本机设置，然后跳回应用首页。
 * 令牌不会出现在任何跳转链接里。
 */

const root = document.getElementById('root') as HTMLElement

const render = (text: string, action?: { label: string; href: string }) => {
  root.textContent = ''
  const wrapper = document.createElement('div')
  wrapper.style.cssText =
    'display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;height:100vh;padding:24px;text-align:center;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)'

  const message = document.createElement('div')
  message.textContent = text
  wrapper.appendChild(message)

  if (action) {
    const link = document.createElement('a')
    link.href = action.href
    link.textContent = action.label
    link.style.cssText = 'color:var(--dsw-alias-brand-text);text-decoration:none'
    wrapper.appendChild(link)
  }

  root.appendChild(wrapper)
}

const finish = (query: string) => {
  window.location.replace(`./index.html?${query}`)
}

const run = async () => {
  setupTheme()
  const params = new URLSearchParams(window.location.search)
  const pending = readPendingAuthorize()
  const state = params.get('state') ?? ''
  const error = params.get('error') ?? ''

  if (error) {
    clearPendingAuthorize()
    finish(`authorize=${encodeURIComponent(error)}`)
    return
  }

  if (!pending) {
    render(translate('authorizeCallbackExpired'), { label: translate('authorizeBackToApp'), href: './index.html' })
    return
  }

  if (!state || state !== pending.state) {
    clearPendingAuthorize()
    render(translate('authorizeCallbackStateMismatch'), {
      label: translate('authorizeBackToApp'),
      href: './index.html',
    })
    return
  }

  render(translate('authorizeExchanging'))
  try {
    const result = await exchangeAuthorizeState(pending.site, state)
    setApiBaseUrl(result.apiBaseUrl || apiBaseUrlForSite(pending.site))
    setApiKey(result.token)
    clearPendingAuthorize()
    finish('authorize=success')
  } catch (cause) {
    clearPendingAuthorize()
    render(translate('authorizeExchangeFailed', { message: cause instanceof Error ? cause.message : String(cause) }), {
      label: translate('authorizeBackToApp'),
      href: './index.html',
    })
  }
}

void run()
