import {
  closestCenter,
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowDownward,
  CheckCircle as CheckCircleIcon,
  Delete as DeleteIcon,
  DragIndicator,
  Error as ErrorIcon,
  Link,
  LinkOff,
  Refresh as RefreshIcon,
  Warning as WarningIcon,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Paper,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material'
import yaml from 'js-yaml'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  closeAllConnections,
  selectNodeForGroup,
} from 'tauri-plugin-mihomo-api'

import { useVerge } from '@/hooks/use-verge'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import { updateProxyChainConfigInRuntime } from '@/services/cmds'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import {
  clearChainConnection,
  patchChainState,
  readChainState,
} from '@/services/proxy-chain-storage'
import { debugLog } from '@/utils/debug'

import { ProxyChainPresets } from './proxy-chain-presets'
import { SmartChainBuilder } from './smart-chain-builder'

const CHAIN_GROUP_KEY = '__PROXY_CHAIN__'
const HEALTH_CHECK_INTERVAL = 30 * 1000
const FAILURE_THRESHOLD = 2

type ChainHealth = 'idle' | 'healthy' | 'drifted' | 'unhealthy'

interface ProxyChainItem {
  id: string
  name: string
  type?: string
  delay?: number
}

interface ParsedChainConfig {
  proxies?: Array<{
    name: string
    type: string
    [key: string]: any
  }>
}

interface ProxyChainProps {
  proxyChain: ProxyChainItem[]
  onUpdateChain: (chain: ProxyChainItem[]) => void
  chainConfigData?: string | null
  onMarkUnsavedChanges?: () => void
  mode?: string
  selectedGroup?: string | null
}

interface SortableItemProps {
  proxy: ProxyChainItem
  index: number
  isFirst: boolean
  isLast: boolean
  onRemove: (id: string) => void
}

const toChainItems = (
  parsedConfig: ParsedChainConfig | null | undefined,
): ProxyChainItem[] => {
  const timestamp = Date.now()

  return (
    parsedConfig?.proxies?.map((proxy, index) => ({
      id: `${proxy.name}_${timestamp}_${index}`,
      name: proxy.name,
      type: proxy.type,
      delay: undefined,
    })) || []
  )
}

const SortableItem = ({
  proxy,
  index,
  isFirst,
  isLast,
  onRemove,
}: SortableItemProps) => {
  const theme = useTheme()
  const { t } = useTranslation()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: proxy.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const roleLabel = isFirst
    ? t('proxies.page.chain.entryNode')
    : isLast
      ? t('proxies.page.chain.exitNode')
      : undefined

  const roleColor = isFirst
    ? theme.palette.success.main
    : isLast
      ? theme.palette.warning.main
      : undefined

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        mb: 0,
        display: 'flex',
        alignItems: 'center',
        p: 1,
        backgroundColor: isDragging
          ? theme.palette.action.selected
          : theme.palette.background.default,
        borderRadius: 1,
        border: roleColor
          ? `1.5px solid ${roleColor}`
          : `1px solid ${theme.palette.divider}`,
        boxShadow: isDragging ? theme.shadows[4] : theme.shadows[1],
        transition: 'box-shadow 0.2s, background-color 0.2s',
      }}
    >
      <Box
        {...attributes}
        {...listeners}
        sx={{
          display: 'flex',
          alignItems: 'center',
          mr: 1,
          color: theme.palette.text.secondary,
          cursor: 'grab',
          '&:active': {
            cursor: 'grabbing',
          },
        }}
      >
        <DragIndicator />
      </Box>

      {roleLabel ? (
        <Chip
          label={roleLabel}
          size="small"
          sx={{
            mr: 1,
            fontWeight: 700,
            color: '#fff',
            backgroundColor: roleColor,
          }}
        />
      ) : (
        <Chip
          label={`${index + 1}`}
          size="small"
          color="primary"
          sx={{ mr: 1, minWidth: 32 }}
        />
      )}

      <Typography
        variant="body2"
        sx={{
          flex: 1,
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {proxy.name}
      </Typography>

      {proxy.type && (
        <Chip
          label={proxy.type}
          size="small"
          variant="outlined"
          sx={{ mr: 1 }}
        />
      )}

      {proxy.delay !== undefined && (
        <Chip
          label={
            proxy.delay > 0
              ? `${proxy.delay}ms`
              : t('shared.labels.timeout') || '超时'
          }
          size="small"
          color={
            proxy.delay > 0 && proxy.delay < 200
              ? 'success'
              : proxy.delay > 0 && proxy.delay < 800
                ? 'warning'
                : 'error'
          }
          sx={{ mr: 1, fontSize: '0.7rem', minWidth: 50 }}
        />
      )}

      <IconButton
        size="small"
        onClick={() => onRemove(proxy.id)}
        sx={{
          color: theme.palette.error.main,
          '&:hover': {
            backgroundColor: theme.palette.error.light + '20',
          },
        }}
      >
        <DeleteIcon fontSize="small" />
      </IconButton>
    </Box>
  )
}

export const ProxyChain = ({
  proxyChain,
  onUpdateChain,
  chainConfigData,
  onMarkUnsavedChanges,
  mode,
  selectedGroup,
}: ProxyChainProps) => {
  const theme = useTheme()
  const { t } = useTranslation()
  const { proxies } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const { verge } = useVerge()
  const latencyTimeout = verge?.default_latency_timeout || 10000
  const [isConnecting, setIsConnecting] = useState(false)
  const [isRechecking, setIsRechecking] = useState(false)
  const [uiMode, setUiMode] = useState<'smart' | 'advanced'>(() => {
    try {
      const stored = localStorage.getItem('proxy-chain-ui-mode')
      if (stored === 'smart' || stored === 'advanced') {
        return stored
      }
    } catch {
      // ignore
    }
    return 'smart'
  })

  const handleUiModeChange = useCallback(
    (_event: React.MouseEvent<HTMLElement>, next: 'smart' | 'advanced' | null) => {
      if (next !== 'smart' && next !== 'advanced') {
        return
      }
      setUiMode(next)
      try {
        localStorage.setItem('proxy-chain-ui-mode', next)
      } catch {
        // ignore
      }
    },
    [],
  )
  const [unhealthyNode, setUnhealthyNode] = useState<string | null>(null)
  const failureCountRef = useRef(0)
  const hasBeenConnectedRef = useRef(false)
  const runHealthCheckRef = useRef<() => Promise<void>>(async () => {})
  const markUnsavedChanges = useCallback(() => {
    onMarkUnsavedChanges?.()
  }, [onMarkUnsavedChanges])

  const isConnected = useMemo(() => {
    if (!proxies || proxyChain.length < 2) {
      return false
    }

    const lastNode = proxyChain[proxyChain.length - 1]

    if (mode === 'global') {
      return proxies.global?.now === lastNode.name
    }

    if (!selectedGroup || !Array.isArray(proxies.groups)) {
      return false
    }

    const proxyChainGroup = proxies.groups.find(
      (group: { name: string }) => group.name === selectedGroup,
    )

    return proxyChainGroup?.now === lastNode.name
  }, [proxies, proxyChain, mode, selectedGroup])

  // 监听链的变化，但排除从配置加载的情况
  const chainLengthRef = useRef(proxyChain.length)
  useEffect(() => {
    // 只有当链长度发生变化且不是初始加载时，才标记为未保存
    if (
      chainLengthRef.current !== proxyChain.length &&
      chainLengthRef.current !== 0
    ) {
      markUnsavedChanges()
    }
    chainLengthRef.current = proxyChain.length
  }, [proxyChain.length, markUnsavedChanges])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event

      if (active.id !== over?.id) {
        const oldIndex = proxyChain.findIndex((item) => item.id === active.id)
        const newIndex = proxyChain.findIndex((item) => item.id === over?.id)

        onUpdateChain(arrayMove(proxyChain, oldIndex, newIndex))
        markUnsavedChanges()
      }
    },
    [proxyChain, onUpdateChain, markUnsavedChanges],
  )

  const handleRemoveProxy = useCallback(
    (id: string) => {
      const newChain = proxyChain.filter((item) => item.id !== id)
      onUpdateChain(newChain)
      markUnsavedChanges()
    },
    [proxyChain, onUpdateChain, markUnsavedChanges],
  )

  const handleConnect = useCallback(async () => {
    if (isConnected) {
      setIsConnecting(true)
      try {
        await updateProxyChainConfigInRuntime(null)

        const targetGroup =
          mode === 'global'
            ? 'GLOBAL'
            : selectedGroup || readChainState().group

        if (targetGroup) {
          try {
            await selectNodeForGroup(targetGroup, 'DIRECT')
          } catch {
            if (proxyChain.length >= 1) {
              try {
                await selectNodeForGroup(targetGroup, proxyChain[0].name)
              } catch {
                // ignore
              }
            }
          }
        }

        clearChainConnection()

        await closeAllConnections()
        await refreshProxy()

        onUpdateChain([])
      } catch (error) {
        console.error('Failed to disconnect from proxy chain:', error)
        showNotice.error(
          t('proxies.page.chain.disconnectFailed') || '断开链式代理失败',
          error,
        )
      } finally {
        setIsConnecting(false)
      }
      return
    }

    if (proxyChain.length < 2) {
      showNotice.info(
        t('proxies.page.chain.minimumNodes') || '链式代理至少需要2个节点',
      )
      return
    }

    setIsConnecting(true)
    try {
      // 第一步：保存链式代理配置
      const chainProxies = proxyChain.map((node) => node.name)
      debugLog('Saving chain config:', chainProxies)
      await updateProxyChainConfigInRuntime(chainProxies)
      debugLog('Chain configuration saved successfully')

      // 第二步：连接到代理链的最后一个节点
      const lastNode = proxyChain[proxyChain.length - 1]
      debugLog(`Connecting to proxy chain, last node: ${lastNode.name}`)

      // 根据模式确定使用的代理组名称
      if (mode !== 'global' && !selectedGroup) {
        throw new Error('规则模式下必须选择代理组')
      }

      const targetGroup = mode === 'global' ? 'GLOBAL' : selectedGroup

      await selectNodeForGroup(targetGroup || 'GLOBAL', lastNode.name)
      patchChainState({
        group: targetGroup || 'GLOBAL',
        exitNode: lastNode.name,
      })

      // 刷新代理信息以更新连接状态
      await refreshProxy()
      // 连接后立即做一次端到端探测，不等 30s 心跳
      failureCountRef.current = 0
      setUnhealthyNode(null)
      runHealthCheckRef.current().catch(() => {})
      debugLog('Successfully connected to proxy chain')
    } catch (error) {
      console.error('Failed to connect to proxy chain:', error)
      showNotice.error(
        t('proxies.page.chain.connectFailed') || '连接链式代理失败',
        error,
      )
    } finally {
      setIsConnecting(false)
    }
  }, [
    proxyChain,
    isConnected,
    t,
    refreshProxy,
    mode,
    selectedGroup,
    onUpdateChain,
  ])

  const proxyChainRef = useRef(proxyChain)
  const onUpdateChainRef = useRef(onUpdateChain)

  useEffect(() => {
    proxyChainRef.current = proxyChain
    onUpdateChainRef.current = onUpdateChain
  }, [proxyChain, onUpdateChain])

  const runHealthCheck = useCallback(async (): Promise<void> => {
    const currentChain = proxyChainRef.current
    if (currentChain.length < 2) return

    const chainNames = currentChain.map((n) => n.name)

    try {
      const results = await Promise.all(
        chainNames.map((name) =>
          delayManager.checkDelay(name, CHAIN_GROUP_KEY, latencyTimeout),
        ),
      )

      // Pull updated history into proxies.records so the display effect updates
      refreshProxy().catch(() => {})

      let failingNode: string | null = null
      for (let i = 0; i < results.length; i++) {
        const d = results[i].delay
        if (d === 0 || d > 1e5) {
          failingNode = chainNames[i]
          break
        }
      }

      if (failingNode) {
        failureCountRef.current += 1
        if (failureCountRef.current >= FAILURE_THRESHOLD) {
          setUnhealthyNode(failingNode)
        }
      } else {
        failureCountRef.current = 0
        setUnhealthyNode(null)
      }
    } catch (error) {
      console.error('Chain health check failed:', error)
    }
  }, [latencyTimeout, refreshProxy])

  useEffect(() => {
    runHealthCheckRef.current = runHealthCheck
  }, [runHealthCheck])

  // Track whether the chain has ever been actively connected so we don't
  // raise drift alerts for chains that were merely loaded from storage.
  useEffect(() => {
    if (isConnected) {
      hasBeenConnectedRef.current = true
    } else if (proxyChain.length === 0) {
      hasBeenConnectedRef.current = false
    }
  }, [isConnected, proxyChain.length])

  // Derive chain health from connection state and the latest test results.
  const chainHealth: ChainHealth = useMemo(() => {
    if (proxyChain.length < 2) return 'idle'
    if (!isConnected) {
      return hasBeenConnectedRef.current ? 'drifted' : 'idle'
    }
    const stillInChain =
      unhealthyNode !== null &&
      proxyChain.some((node) => node.name === unhealthyNode)
    return stillInChain ? 'unhealthy' : 'healthy'
  }, [proxyChain, isConnected, unhealthyNode])

  const driftedTo: string | null = useMemo(() => {
    if (chainHealth !== 'drifted') return null
    const targetGroup = mode === 'global' ? 'GLOBAL' : selectedGroup
    if (!targetGroup || !Array.isArray(proxies?.groups)) return null
    const grp = proxies.groups.find(
      (g: { name: string }) => g.name === targetGroup,
    )
    return grp?.now || null
  }, [chainHealth, mode, selectedGroup, proxies])

  const healthMeta = useMemo<{
    label: string
    color: 'default' | 'success' | 'warning' | 'error'
    icon: React.ReactElement
  }>(() => {
    switch (chainHealth) {
      case 'healthy':
        return {
          label: t('proxies.page.chain.health.healthy') || '已连通',
          color: 'success',
          icon: <CheckCircleIcon sx={{ fontSize: 16 }} />,
        }
      case 'drifted':
        return {
          label:
            t('proxies.page.chain.health.drifted') || '出口节点已被切换',
          color: 'warning',
          icon: <WarningIcon sx={{ fontSize: 16 }} />,
        }
      case 'unhealthy':
        return {
          label: t('proxies.page.chain.health.unhealthy') || '链路异常',
          color: 'error',
          icon: <ErrorIcon sx={{ fontSize: 16 }} />,
        }
      case 'idle':
      default:
        return {
          label: t('proxies.page.chain.health.idle') || '未连接',
          color: 'default',
          icon: <LinkOff sx={{ fontSize: 16 }} />,
        }
    }
  }, [chainHealth, t])

  // Active periodic delay testing while a chain is configured.
  useEffect(() => {
    if (proxyChain.length < 2) return

    let cancelled = false

    const tick = async () => {
      if (cancelled) return
      if (
        typeof document !== 'undefined' &&
        document.visibilityState !== 'visible'
      ) {
        return
      }
      await runHealthCheck()
    }

    tick()
    const timer = setInterval(tick, HEALTH_CHECK_INTERVAL)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [proxyChain.length, runHealthCheck])

  const handleRecheck = useCallback(async () => {
    setIsRechecking(true)
    try {
      await runHealthCheck()
    } finally {
      setIsRechecking(false)
    }
  }, [runHealthCheck])

  const handleRecover = useCallback(async () => {
    if (proxyChain.length < 2) return
    if (mode !== 'global' && !selectedGroup) return

    setIsConnecting(true)
    try {
      const lastNode = proxyChain[proxyChain.length - 1]
      const targetGroup = mode === 'global' ? 'GLOBAL' : selectedGroup

      await closeAllConnections()
      await selectNodeForGroup(targetGroup || 'GLOBAL', lastNode.name)
      patchChainState({
        group: targetGroup || 'GLOBAL',
        exitNode: lastNode.name,
      })
      await refreshProxy()

      failureCountRef.current = 0
      setUnhealthyNode(null)

      await runHealthCheck()
    } catch (error) {
      console.error('Failed to recover proxy chain:', error)
      showNotice.error(
        t('proxies.page.chain.connectFailed') || '连接链式代理失败',
        error,
      )
    } finally {
      setIsConnecting(false)
    }
  }, [proxyChain, mode, selectedGroup, refreshProxy, runHealthCheck, t])

  // 处理链式代理配置数据
  useEffect(() => {
    if (chainConfigData) {
      try {
        // JSON is valid YAML, so one parser covers both persisted formats.
        const parsedConfig = yaml.load(chainConfigData) as ParsedChainConfig
        const chainItems = toChainItems(parsedConfig)

        if (chainItems.length > 0) {
          onUpdateChain(chainItems)
        }
      } catch (error) {
        console.error('Failed to process chain config data:', error)
      }
    }
  }, [chainConfigData, onUpdateChain])

  // 定时更新延迟数据
  useEffect(() => {
    if (!proxies?.records) return

    const updateDelays = () => {
      const currentChain = proxyChainRef.current
      if (currentChain.length === 0) return

      const updatedChain = currentChain.map((item) => {
        const proxyRecord = proxies.records[item.name]
        if (
          proxyRecord &&
          proxyRecord.history &&
          proxyRecord.history.length > 0
        ) {
          const latestDelay =
            proxyRecord.history[proxyRecord.history.length - 1].delay
          return { ...item, delay: latestDelay }
        }
        return item
      })

      // 只有在延迟数据确实发生变化时才更新
      const hasChanged = updatedChain.some(
        (item, index) => item.delay !== currentChain[index]?.delay,
      )

      if (hasChanged) {
        onUpdateChainRef.current(updatedChain)
      }
    }

    // 立即更新一次延迟
    updateDelays()

    // 设置定时器，每5秒更新一次延迟
    const interval = setInterval(updateDelays, 5000)

    return () => clearInterval(interval)
  }, [proxies?.records]) // 只依赖proxies.records

  return (
    <Paper
      elevation={1}
      sx={{
        height: '100%',
        p: 2,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 2,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h6">
            {t('proxies.page.chain.header')}
          </Typography>
          {proxyChain.length >= 2 && (
            <Chip
              size="small"
              color={healthMeta.color}
              icon={healthMeta.icon}
              label={healthMeta.label}
              sx={{ fontWeight: 600 }}
            />
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {proxyChain.length >= 2 && (
            <IconButton
              size="small"
              onClick={handleRecheck}
              disabled={isRechecking}
              title={t('proxies.page.actions.recheck') || '立即测速'}
              sx={{
                color: theme.palette.primary.main,
                '&:hover': {
                  backgroundColor: theme.palette.primary.light + '20',
                },
              }}
            >
              <RefreshIcon
                fontSize="small"
                sx={{
                  animation: isRechecking
                    ? 'chain-recheck-spin 1s linear infinite'
                    : undefined,
                  '@keyframes chain-recheck-spin': {
                    from: { transform: 'rotate(0deg)' },
                    to: { transform: 'rotate(360deg)' },
                  },
                }}
              />
            </IconButton>
          )}
          {proxyChain.length > 0 && (
            <IconButton
              size="small"
              onClick={() => {
                updateProxyChainConfigInRuntime(null)
                clearChainConnection()
                onUpdateChain([])
              }}
              sx={{
                color: theme.palette.error.main,
                '&:hover': {
                  backgroundColor: theme.palette.error.light + '20',
                },
              }}
              title={
                t('proxies.page.actions.clearChainConfig') || '删除链式配置'
              }
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          )}
          {(() => {
            const needsGroup = mode !== 'global' && !selectedGroup
            const tooManyNodes = proxyChain.length < 2
            const disabled = isConnecting || tooManyNodes || needsGroup
            const tooltip = isConnected
              ? ''
              : tooManyNodes
                ? t('proxies.page.chain.minimumNodes') ||
                  '链式代理至少需要2个节点'
                : needsGroup
                  ? t('proxies.page.chain.presets.feedback.noTargetGroup')
                  : ''
            const button = (
              <Button
                size="small"
                variant="contained"
                startIcon={isConnected ? <LinkOff /> : <Link />}
                onClick={handleConnect}
                disabled={disabled}
                color={isConnected ? 'error' : 'success'}
                sx={{ minWidth: 90 }}
              >
                {isConnecting
                  ? t('proxies.page.actions.connecting') || '连接中...'
                  : isConnected
                    ? t('proxies.page.actions.disconnect') || '断开'
                    : t('proxies.page.actions.connect') || '连接'}
              </Button>
            )
            return tooltip ? (
              <Tooltip title={tooltip} arrow>
                <span>{button}</span>
              </Tooltip>
            ) : (
              button
            )
          })()}
        </Box>
      </Box>

      <ToggleButtonGroup
        value={uiMode}
        exclusive
        size="small"
        onChange={handleUiModeChange}
        sx={{ mb: 2 }}
      >
        <ToggleButton value="smart">
          {t('proxies.page.chain.smart.tab')}
        </ToggleButton>
        <ToggleButton value="advanced">
          {t('proxies.page.chain.smart.advancedTab')}
        </ToggleButton>
      </ToggleButtonGroup>

      {uiMode === 'smart' ? (
        <SmartChainBuilder mode={mode || 'rule'} selectedGroup={selectedGroup} />
      ) : (
        <>
          <ProxyChainPresets
            currentChain={proxyChain}
            mode={mode || 'rule'}
            selectedGroup={selectedGroup}
            onApplyChain={onUpdateChain}
          />

      {(chainHealth === 'drifted' || chainHealth === 'unhealthy') && (
        <Alert
          severity={chainHealth === 'drifted' ? 'warning' : 'error'}
          sx={{ mb: 2 }}
          action={
            <Button
              size="small"
              color="inherit"
              variant="outlined"
              onClick={handleRecover}
              disabled={isConnecting}
            >
              {t('proxies.page.actions.recover') || '恢复连接'}
            </Button>
          }
        >
          {chainHealth === 'drifted'
            ? t('proxies.page.chain.health.driftedHint', {
                node: driftedTo || '?',
              }) ||
              `出口节点已被切换为 ${driftedTo || '?'}，链式代理可能已失效。`
            : t('proxies.page.chain.health.unhealthyHint', {
                node: unhealthyNode || '?',
              }) ||
              `节点 ${unhealthyNode || '?'} 不可达，链路异常。`}
        </Alert>
      )}

      <Alert
        severity={proxyChain.length === 1 ? 'warning' : 'info'}
        sx={{ mb: 2 }}
      >
        {proxyChain.length === 1
          ? t('proxies.page.chain.minimumNodesHint') ||
            '链式代理至少需要2个节点，请再添加一个节点。'
          : t('proxies.page.chain.instruction') ||
            '按顺序点击节点添加到代理链中'}
      </Alert>

      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {proxyChain.length === 0 ? (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: theme.palette.text.secondary,
            }}
          >
            <Typography>{t('proxies.page.chain.empty')}</Typography>
          </Box>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={proxyChain.map((proxy) => proxy.id)}
              strategy={verticalListSortingStrategy}
            >
              <Box
                sx={{
                  borderRadius: 1,
                  minHeight: 60,
                  p: 1,
                }}
              >
                {proxyChain.map((proxy, index) => (
                  <Box key={proxy.id}>
                    <SortableItem
                      proxy={proxy}
                      index={index}
                      isFirst={index === 0}
                      isLast={
                        index === proxyChain.length - 1 && proxyChain.length > 1
                      }
                      onRemove={handleRemoveProxy}
                    />
                    {index < proxyChain.length - 1 && (
                      <Box
                        sx={{
                          display: 'flex',
                          justifyContent: 'center',
                          py: 0.25,
                        }}
                      >
                        <ArrowDownward
                          sx={{
                            fontSize: 20,
                            color: theme.palette.primary.main,
                            opacity: 0.7,
                          }}
                        />
                      </Box>
                    )}
                  </Box>
                ))}
              </Box>
            </SortableContext>
          </DndContext>
        )}
          </Box>
        </>
      )}
    </Paper>
  )
}
