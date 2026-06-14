import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  closeAllConnections,
  selectNodeForGroup,
} from 'tauri-plugin-mihomo-api'

import { useVerge } from '@/hooks/use-verge'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import { notifyChainAnomaly } from '@/services/chain-notify'
import { updateSmartChainConfigInRuntime } from '@/services/cmds'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import { patchChainState, readChainState } from '@/services/proxy-chain-storage'
import {
  buildSmartChainPayload,
  DEFAULT_HEALTH_URL,
} from '@/utils/chain-config-builder'
import { collectHopMatches, resolveChainGroups } from '@/utils/chain-resolver'

// 端到端探测出口跳用的分组键，与手动链(proxy-chain.tsx)共用一套延迟缓存命名。
const CHAIN_GROUP_KEY = '__PROXY_CHAIN__'
// 实时连通探测间隔：尽量贴近"实时"，又避免过于频繁。探测自带在途守卫不会重叠。
const LIVE_PROBE_INTERVAL = 5 * 1000
const FAILURE_THRESHOLD = 2

export type ChainLiveStatus = 'online' | 'offline' | 'checking' | 'idle'

const isDownDelay = (delay: number) => delay === 0 || delay > 1e5

export function useSmartChain(
  mode: string,
  selectedGroup: string | null | undefined,
) {
  const { verge } = useVerge()
  const { proxies } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const timeout = verge?.default_latency_timeout || 10000
  const [hops, setHops] = useState<IChainHop[]>(
    () => readChainState().hops ?? [],
  )
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState<boolean>(() => {
    const s = readChainState()
    return !!s.group && (s.hops?.length ?? 0) >= 2
  })
  // 整链是否经端到端探测判定为全不可达（区别于"连接前的逐跳直连快照"）。
  const [chainDown, setChainDown] = useState(false)
  // 实时连通状态：每次端到端探测后立即更新，用于"当前是否在线"的显示。
  const [liveStatus, setLiveStatus] = useState<ChainLiveStatus>(() => {
    const s = readChainState()
    return !!s.group && (s.hops?.length ?? 0) >= 2 ? 'checking' : 'idle'
  })
  const [refreshing, setRefreshing] = useState(false)
  const failureRef = useRef(0)
  const downNotifiedRef = useRef(false)
  const probingRef = useRef(false)

  const resolvedGroups = useMemo(
    () => resolveChainGroups(hops, proxies?.records, { timeout }),
    [hops, proxies?.records, timeout],
  )

  const hopStatus = useMemo(
    () =>
      resolvedGroups.map((g) => {
        const grp = proxies?.groups?.find(
          (pg: { name: string; now?: string }) => pg.name === g.groupName,
        )
        return {
          groupName: g.groupName,
          value: g.value,
          now: grp?.now ?? null,
          healthyCount: g.healthyCount,
        }
      }),
    [resolvedGroups, proxies?.groups],
  )

  const overallStatus = useMemo<'healthy' | 'degraded' | 'down'>(() => {
    if (resolvedGroups.length === 0) return 'healthy'
    if (resolvedGroups.some((g) => g.healthyCount === 0)) return 'down'
    if (resolvedGroups.some((g) => g.healthyCount === 1)) return 'degraded'
    return 'healthy'
  }, [resolvedGroups])

  const targetGroup = mode === 'global' ? 'GLOBAL' : selectedGroup || null

  // 端到端探测出口跳：出口节点已被注入 dialer-proxy，测速会自动经由整条链，
  // 因此这是"整链是否真正连通"的可靠信号（而非各跳的直连可达性）。
  // 探测某个出口组（已注入 dialer-proxy，测速自动经由整条链）是否连通。
  const probeGroup = useCallback(
    async (groupName: string): Promise<boolean> => {
      const res = await delayManager.checkDelay(
        groupName,
        CHAIN_GROUP_KEY,
        timeout,
      )
      return !isDownDelay(res.delay)
    },
    [timeout],
  )

  const probeExit = useCallback(async (): Promise<boolean> => {
    const exitGroup = resolvedGroups[resolvedGroups.length - 1]?.groupName
    if (!exitGroup) return false
    return probeGroup(exitGroup)
  }, [resolvedGroups, probeGroup])

  // 统一的整链端到端探测：立即更新实时连通状态，并按连续失败阈值触发一次"全断"通知。
  // 在途守卫避免高频探测相互重叠。
  const runProbe = useCallback(async (): Promise<boolean> => {
    if (probingRef.current) return false
    probingRef.current = true
    try {
      const ok = await probeExit().catch(() => false)
      setLiveStatus(ok ? 'online' : 'offline')
      if (ok) {
        failureRef.current = 0
        downNotifiedRef.current = false
        setChainDown(false)
      } else {
        failureRef.current += 1
        if (failureRef.current >= FAILURE_THRESHOLD) {
          setChainDown(true)
          if (!downNotifiedRef.current) {
            downNotifiedRef.current = true
            showNotice.error('proxies.page.chain.smart.allDownNotice')
            notifyChainAnomaly('proxies.page.chain.smart.allDownNotice')
          }
        }
      }
      return ok
    } finally {
      probingRef.current = false
    }
  }, [probeExit])

  // 连接智能链。
  // - overrideHops：传入指定跳直接连（预设一键连接 / 快速向导用），免去先 setHops 再连的异步等待。
  // - opts.seamless：平切，已连接时切换链路不强制关闭所有连接，旧连接自然收敛、新连接走新链，减少断流。
  const connect = useCallback(
    async (
      overrideHops?: IChainHop[],
      opts?: { seamless?: boolean },
    ): Promise<boolean> => {
      const effHops = overrideHops ?? hops
      if (effHops.length < 2 || !targetGroup) return false
      const groups = overrideHops
        ? resolveChainGroups(overrideHops, proxies?.records, { timeout })
        : resolvedGroups
      setBusy(true)
      try {
        if (overrideHops) setHops(overrideHops)
        const payload = buildSmartChainPayload(groups, targetGroup, {
          healthUrl: DEFAULT_HEALTH_URL,
          interval: 60,
          tolerance: 50,
        })
        await updateSmartChainConfigInRuntime(payload)
        const exitGroup = payload.hops[payload.hops.length - 1].name
        await selectNodeForGroup(targetGroup, exitGroup)
        patchChainState({
          group: targetGroup,
          exitNode: exitGroup,
          hops: effHops,
        })
        if (!opts?.seamless) {
          await closeAllConnections()
        }
        await refreshProxy()

        // 先把链配好，再判断整链是否真正连通（端到端探测出口）。
        failureRef.current = 0
        downNotifiedRef.current = false
        setChainDown(false)
        setConnected(true)
        setLiveStatus('checking')
        const ok = await probeGroup(exitGroup).catch(() => false)
        setLiveStatus(ok ? 'online' : 'offline')
        if (!ok) {
          downNotifiedRef.current = true
          setChainDown(true)
          showNotice.error('proxies.page.chain.smart.allDownNotice')
          notifyChainAnomaly('proxies.page.chain.smart.allDownNotice')
        }
        return true
      } catch (err) {
        showNotice.error('proxies.page.chain.connectFailed', err)
        return false
      } finally {
        setBusy(false)
      }
    },
    [
      hops,
      resolvedGroups,
      targetGroup,
      refreshProxy,
      proxies?.records,
      timeout,
      probeGroup,
    ],
  )

  const disconnect = useCallback(async () => {
    setBusy(true)
    try {
      await updateSmartChainConfigInRuntime(null)
      patchChainState({ group: null, exitNode: null, hops: [] })
      await closeAllConnections()
      await refreshProxy()
      setHops([])
      setConnected(false)
      setChainDown(false)
      setLiveStatus('idle')
      failureRef.current = 0
      downNotifiedRef.current = false
    } catch (err) {
      showNotice.error('proxies.page.chain.disconnectFailed', err)
    } finally {
      setBusy(false)
    }
  }, [refreshProxy])

  // 手动刷新健康节点：重测前置（非固定）跳匹配到的所有节点（含已掉线的，便于恢复后重新入选），
  // 刷新候选与最优；已连接时顺带端到端复测出口，立即更新实时连通状态。
  const refreshHealth = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const names = collectHopMatches(
        hops.filter((h) => h.kind !== 'pinned'),
        proxies?.records,
      )
      if (names.length) {
        await delayManager.checkListDelay(names, CHAIN_GROUP_KEY, timeout)
      }
      await refreshProxy()
      if (connected) {
        setLiveStatus('checking')
        await runProbe()
      }
    } finally {
      setRefreshing(false)
    }
  }, [
    refreshing,
    hops,
    proxies?.records,
    timeout,
    refreshProxy,
    connected,
    runProbe,
  ])

  // 连接后周期性端到端探测整链（贴近实时）；每次探测立即更新实时连通状态，
  // 连续失败到阈值则判定整链中断并发一次通知。
  useEffect(() => {
    if (!connected || hops.length < 2) return
    let cancelled = false

    const tick = async () => {
      if (cancelled) return
      if (
        typeof document !== 'undefined' &&
        document.visibilityState !== 'visible'
      ) {
        return
      }
      await runProbe()
    }

    tick()
    const timer = setInterval(tick, LIVE_PROBE_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connected, hops.length, runProbe])

  return {
    hops,
    setHops,
    resolvedGroups,
    hopStatus,
    overallStatus,
    connect,
    disconnect,
    busy,
    targetGroup,
    connected,
    chainDown,
    liveStatus,
    refreshHealth,
    refreshing,
  }
}

export type UseSmartChain = ReturnType<typeof useSmartChain>
