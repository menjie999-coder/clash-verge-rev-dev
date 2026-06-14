import i18n from 'i18next'

import { flashWindowAttention, sendDesktopNotification } from '@/services/cmds'

/**
 * 发送一条"链式代理异常"的系统桌面通知（应用在后台/最小化时也能弹出）。
 *
 * 标题统一，正文由调用方给出的 i18n key 决定，便于复用到智能链与手动链两套监控。
 * 失败静默：通知不是关键路径，不应影响链路监控本身。
 */
// 动态 key 通知，绕过 i18next 严格的 selector 类型（标题/正文键在运行时已校验存在）。
const translate = i18n.t as unknown as (
  key: string,
  params?: Record<string, unknown>,
) => string

export function notifyChainAnomaly(
  bodyKey: string,
  params?: Record<string, unknown>,
): void {
  const title = translate('proxies.page.chain.smart.anomalyTitle')
  const body = translate(bodyKey, params ?? {})
  // 双保险：系统通知（可能被通知设置/专注助手拦截）+ 任务栏闪烁（不依赖通知设置）。
  sendDesktopNotification(title, body).catch(() => {})
  flashWindowAttention().catch(() => {})
}
