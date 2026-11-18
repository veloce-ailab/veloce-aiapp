import { App as CapacitorApp } from '@capacitor/app'
import { completeAuthorize, isNativePlatform } from './authorize.js'
import { showToast } from '../components/base/toastState.js'
import { translate } from '../i18n/index.js'

/**
 * 原生应用的授权回调：站点授权完成后打开 `com.veloce.aiapp://auth/callback?state=…`，
 * 系统把应用拉回前台并触发 appUrlOpen，这里负责用 state 换令牌。
 */

const CALLBACK_PREFIX = 'com.veloce.aiapp://'

const handle = async (url: string) => {
  if (!url.startsWith(CALLBACK_PREFIX)) {
    return
  }
  const outcome = await completeAuthorize(url)
  switch (outcome.status) {
    case 'success':
      showToast(translate('authorizeSuccessToast'))
      break
    case 'denied':
      showToast(translate('authorizeDeniedToast'))
      break
    case 'expired':
      showToast(translate('authorizeCallbackExpired'))
      break
    case 'mismatch':
      showToast({ key: 'authorizeCallbackStateMismatch', type: 'error' })
      break
    case 'failed':
      showToast({ key: 'authorizeExchangeFailed', params: { message: outcome.message }, type: 'error' })
      break
  }
}

/** 在原生环境注册深链监听；返回解绑函数，网页端为空操作 */
export const bindAuthorizeDeepLink = () => {
  if (!isNativePlatform()) {
    return () => {}
  }
  const listener = CapacitorApp.addListener('appUrlOpen', ({ url }) => {
    void handle(url)
  })
  // 应用被深链冷启动时不会触发 appUrlOpen，需要单独读取启动地址
  void CapacitorApp.getLaunchUrl().then((launch) => {
    if (launch?.url) {
      void handle(launch.url)
    }
  })
  return () => {
    void listener.then((registered) => registered.remove())
  }
}
