import { useCallback, useMemo, useState } from 'react'
import {
  closeAllConnections,
  selectNodeForGroup,
} from 'tauri-plugin-mihomo-api'

import { useVerge } from '@/hooks/use-verge'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import { updateSmartChainConfigInRuntime } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { patchChainState, readChainState } from '@/services/proxy-chain-storage'
import {
  buildSmartChainPayload,
  DEFAULT_HEALTH_URL,
} from '@/utils/chain-config-builder'
import { resolveChainGroups } from '@/utils/chain-resolver'

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

  const connect = useCallback(async (): Promise<boolean> => {
    if (hops.length < 2 || !targetGroup) return false
    setBusy(true)
    try {
      const payload = buildSmartChainPayload(resolvedGroups, targetGroup, {
        healthUrl: DEFAULT_HEALTH_URL,
        interval: 60,
        tolerance: 50,
      })
      await updateSmartChainConfigInRuntime(payload)
      const exitGroup = payload.hops[payload.hops.length - 1].name
      await selectNodeForGroup(targetGroup, exitGroup)
      patchChainState({ group: targetGroup, exitNode: exitGroup, hops })
      await closeAllConnections()
      await refreshProxy()
      return true
    } catch (err) {
      showNotice.error('proxies.page.chain.connectFailed', err)
      return false
    } finally {
      setBusy(false)
    }
  }, [hops, resolvedGroups, targetGroup, refreshProxy])

  const disconnect = useCallback(async () => {
    setBusy(true)
    try {
      await updateSmartChainConfigInRuntime(null)
      patchChainState({ group: null, exitNode: null, hops: [] })
      await closeAllConnections()
      await refreshProxy()
      setHops([])
    } catch (err) {
      showNotice.error('proxies.page.chain.disconnectFailed', err)
    } finally {
      setBusy(false)
    }
  }, [refreshProxy])

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
  }
}
