import {
  closestCenter,
  DndContext,
  type DragEndEvent,
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
  ArrowForward,
  Delete as DeleteIcon,
  DragIndicator,
  PushPin as PushPinIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Select,
  TextField,
  Typography,
  useTheme,
} from '@mui/material'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { UseSmartChain } from '@/hooks/use-smart-chain'
import { useVerge } from '@/hooks/use-verge'
import { useProxiesData } from '@/providers/app-data-context'
import { updateProxyChainConfigInRuntime } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { classifyActiveChain } from '@/services/proxy-chain-storage'
import {
  isUsableNode,
  latestDelay,
  type MatchableProxy,
  REGION_PATTERNS,
} from '@/utils/chain-preset-match'
import {
  resolveChainGroups,
  type ResolvedHopGroup,
} from '@/utils/chain-resolver'

const TEMPLATES: string[][] = [
  ['HK', 'US'],
  ['HK', 'JP', 'US'],
]

interface SmartChainBuilderProps {
  smart: UseSmartChain
}

interface HopRowProps {
  group: ResolvedHopGroup
  index: number
  delay?: number
  now?: string | null
  onRemove: (index: number) => void
}

const hopId = (group: ResolvedHopGroup) =>
  `hop-${group.hopIndex}-${group.value}`

const HopRow = ({ group, index, delay, now, onRemove }: HopRowProps) => {
  const theme = useTheme()
  const { t } = useTranslation()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: hopId(group) })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        display: 'flex',
        alignItems: 'center',
        p: 1,
        backgroundColor: isDragging
          ? theme.palette.action.selected
          : theme.palette.background.default,
        borderRadius: 1,
        border: `1px solid ${theme.palette.divider}`,
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
          '&:active': { cursor: 'grabbing' },
        }}
      >
        <DragIndicator />
      </Box>

      <Chip
        label={`${index + 1}`}
        size="small"
        color="primary"
        sx={{ mr: 1, minWidth: 32 }}
      />

      {group.kind === 'pinned' ? (
        <>
          <Chip
            icon={<PushPinIcon sx={{ fontSize: 14 }} />}
            label={t('proxies.page.chain.smart.pinnedExit')}
            size="small"
            color="warning"
            sx={{ mr: 1, fontWeight: 600 }}
          />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {group.value}
            </Typography>
          </Box>
        </>
      ) : (
        <>
          <Typography variant="body2" sx={{ fontWeight: 600, mr: 1 }}>
            {group.value}
          </Typography>

          <ArrowForward
            sx={{ fontSize: 18, mr: 1, color: theme.palette.text.secondary }}
          />

          <Box sx={{ flex: 1, minWidth: 0 }}>
            {group.healthyCount === 0 || !group.bestNode ? (
              <Chip
                label={t('proxies.page.chain.smart.noHealthyNode')}
                size="small"
                color="error"
              />
            ) : (
              <Typography
                variant="body2"
                sx={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {group.bestNode}
                {delay !== undefined && (
                  <Typography
                    component="span"
                    variant="caption"
                    sx={{ ml: 1, color: theme.palette.text.secondary }}
                  >
                    {t('proxies.page.chain.smart.regionBest', { delay })}
                  </Typography>
                )}
              </Typography>
            )}
            {now && (
              <Typography
                variant="caption"
                sx={{
                  display: 'block',
                  color: theme.palette.text.secondary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('proxies.page.chain.smart.currentNode', { node: now })}
              </Typography>
            )}
          </Box>
        </>
      )}

      <IconButton
        size="small"
        onClick={() => onRemove(index)}
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

export const SmartChainBuilder = ({ smart }: SmartChainBuilderProps) => {
  const theme = useTheme()
  const { t } = useTranslation()
  const {
    hops,
    setHops,
    resolvedGroups,
    hopStatus,
    connect,
    disconnect,
    busy,
    targetGroup,
    connected,
    chainDown,
    liveStatus,
    refreshHealth,
    refreshing,
  } = smart
  const { proxies } = useProxiesData()
  const { verge } = useVerge()
  const timeout = verge?.default_latency_timeout || 10000

  const [pendingRegion, setPendingRegion] = useState('')
  const [pendingNode, setPendingNode] = useState<string | null>(null)
  // 快速配置向导（前置地区 → 出口节点）的两个选择。
  const [wizardRegion, setWizardRegion] = useState('')
  const [wizardExit, setWizardExit] = useState<string | null>(null)
  // 互斥确认弹窗：检测到手动链正在使用时，先提醒用户再切换。
  const [confirmOpen, setConfirmOpen] = useState(false)

  const usedRegions = useMemo(
    () => hops.filter((h) => h.kind === 'region').map((h) => h.value),
    [hops],
  )

  const usedValues = useMemo(() => new Set(hops.map((h) => h.value)), [hops])

  // 可作为"固定出口"的真实节点列表（含自导入的 SOCKS5），排除策略组与已在链中的节点。
  const nodeOptions = useMemo(() => {
    const records = proxies?.records as
      | Record<string, MatchableProxy>
      | undefined
    if (!records) return [] as string[]
    return Object.values(records)
      .filter((p) => isUsableNode(p))
      .map((p) => p.name)
      .filter((name) => !usedValues.has(name))
      .sort((a, b) => a.localeCompare(b))
  }, [proxies?.records, usedValues])

  // 全部可用真实节点（快速向导用，向导会整体替换 hops，不按已用过滤）。
  const allUsableNodes = useMemo(() => {
    const records = proxies?.records as
      | Record<string, MatchableProxy>
      | undefined
    if (!records) return [] as string[]
    return Object.values(records)
      .filter((p) => isUsableNode(p))
      .map((p) => p.name)
      .sort((a, b) => a.localeCompare(b))
  }, [proxies?.records])

  const regionHealth = useMemo(() => {
    const map: Record<
      string,
      { healthyCount: number; bestNode: string | null; delay?: number }
    > = {}
    for (const { key } of REGION_PATTERNS) {
      const g = resolveChainGroups(
        [{ kind: 'region', value: key }],
        proxies?.records,
        { timeout },
      )[0]
      map[key] = {
        healthyCount: g.healthyCount,
        bestNode: g.bestNode,
        delay: g.bestNode
          ? latestDelay(proxies?.records?.[g.bestNode])
          : undefined,
      }
    }
    return map
  }, [proxies?.records, timeout])

  const delayFor = useCallback(
    (node: string | null) =>
      node ? latestDelay(proxies?.records?.[node]) : undefined,
    [proxies?.records],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const addRegion = useCallback(() => {
    if (!pendingRegion) return
    if (usedRegions.includes(pendingRegion)) {
      showNotice.info(t('proxies.page.chain.smart.duplicateRegion'))
      return
    }
    setHops([...hops, { kind: 'region', value: pendingRegion }])
    setPendingRegion('')
  }, [pendingRegion, usedRegions, hops, setHops, t])

  const addPinned = useCallback(() => {
    if (!pendingNode) return
    if (usedValues.has(pendingNode)) {
      showNotice.info(t('proxies.page.chain.smart.duplicateNode'))
      return
    }
    setHops([...hops, { kind: 'pinned', value: pendingNode }])
    setPendingNode(null)
  }, [pendingNode, usedValues, hops, setHops, t])

  const applyTemplate = useCallback(
    (template: string[]) => {
      setHops(template.map((k) => ({ kind: 'region' as const, value: k })))
    },
    [setHops],
  )

  const handleRemove = useCallback(
    (index: number) => {
      setHops(hops.filter((_, i) => i !== index))
    },
    [hops, setHops],
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = resolvedGroups.findIndex((g) => hopId(g) === active.id)
      const newIndex = resolvedGroups.findIndex((g) => hopId(g) === over.id)
      if (oldIndex < 0 || newIndex < 0) return
      setHops(arrayMove(hops, oldIndex, newIndex))
    },
    [resolvedGroups, hops, setHops],
  )

  const handleConnect = useCallback(async () => {
    // 互斥：若手动链正在生效，先弹窗提醒，确认后再切换。
    if (classifyActiveChain() === 'manual') {
      setConfirmOpen(true)
      return
    }
    await connect()
  }, [connect])

  const handleConfirmSwitch = useCallback(async () => {
    setConfirmOpen(false)
    // 清理手动链的运行时配置（dialer-proxy），再建立智能链。
    try {
      await updateProxyChainConfigInRuntime(null)
    } catch {
      // ignore：智能链下发本身也会覆盖 dialer-proxy
    }
    await connect()
  }, [connect])

  const handleDisconnect = useCallback(async () => {
    await disconnect()
  }, [disconnect])

  // 快速配置向导：选好"前置地区 + 出口节点"后，一键组成两跳链并连接（平切）。
  const handleQuickConnect = useCallback(async () => {
    if (!wizardRegion || !wizardExit) return
    const newHops: IChainHop[] = [
      { kind: 'region', value: wizardRegion },
      { kind: 'pinned', value: wizardExit },
    ]
    setHops(newHops)
    if (!targetGroup) {
      showNotice.error('proxies.page.chain.presets.feedback.noTargetGroup')
      return
    }
    if (classifyActiveChain() === 'manual') {
      setConfirmOpen(true)
      return
    }
    await connect(newHops, { seamless: connected })
  }, [wizardRegion, wizardExit, setHops, targetGroup, connect, connected])

  // 出口为固定节点(pinned)时不参与"逐跳直连健康"判定；只有地区跳全挂才禁止连接。
  const connectDisabled =
    hops.length < 2 ||
    !targetGroup ||
    resolvedGroups.some((g) => g.kind !== 'pinned' && g.healthyCount === 0) ||
    busy

  // 实时连通状态展示：当前链式代理是否在线（基于端到端探测，约每 5 秒刷新一次）。
  const liveMeta = useMemo<{
    label: string
    color: 'default' | 'success' | 'error' | 'info'
  }>(() => {
    switch (liveStatus) {
      case 'online':
        return {
          label: t('proxies.page.chain.smart.live.online'),
          color: 'success',
        }
      case 'offline':
        return {
          label: t('proxies.page.chain.smart.live.offline'),
          color: 'error',
        }
      case 'checking':
        return {
          label: t('proxies.page.chain.smart.live.checking'),
          color: 'info',
        }
      default:
        return {
          label: t('proxies.page.chain.smart.live.idle'),
          color: 'default',
        }
    }
  }, [liveStatus, t])

  // 未连接时的"下一步该做什么"提示，傻瓜式引导。
  const nextStepHint = useMemo<{ text: string; color: string } | null>(() => {
    if (connected) return null
    if (hops.length < 2) {
      return {
        text: t('proxies.page.chain.smart.hint.needHops'),
        color: theme.palette.text.secondary,
      }
    }
    if (!targetGroup) {
      return {
        text: t('proxies.page.chain.smart.hint.needGroup'),
        color: theme.palette.warning.main,
      }
    }
    if (
      resolvedGroups.some((g) => g.kind !== 'pinned' && g.healthyCount === 0)
    ) {
      return {
        text: t('proxies.page.chain.smart.hint.deadHop'),
        color: theme.palette.error.main,
      }
    }
    return {
      text: t('proxies.page.chain.smart.hint.ready'),
      color: theme.palette.success.main,
    }
  }, [connected, hops.length, targetGroup, resolvedGroups, t, theme])

  return (
    <Paper
      elevation={1}
      sx={{ height: '100%', p: 2, display: 'flex', flexDirection: 'column' }}
    >
      {/* 快速配置向导：前置地区 → 出口节点 → 一键连接（最常见用法的傻瓜式入口） */}
      <Box
        sx={{
          mb: 2,
          p: 1.5,
          borderRadius: 1,
          border: `1px dashed ${theme.palette.primary.main}`,
          backgroundColor: theme.palette.primary.light + '14',
        }}
      >
        <Typography
          variant="caption"
          sx={{ fontWeight: 700, color: theme.palette.primary.main }}
        >
          {t('proxies.page.chain.smart.wizard.title')}
        </Typography>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            mt: 1,
            flexWrap: 'wrap',
          }}
        >
          <Select
            size="small"
            displayEmpty
            value={wizardRegion}
            onChange={(e) => setWizardRegion(e.target.value)}
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="" disabled>
              {t('proxies.page.chain.smart.wizard.frontRegion')}
            </MenuItem>
            {REGION_PATTERNS.map(({ key }) => {
              const health = regionHealth[key]
              return (
                <MenuItem key={key} value={key}>
                  <Typography sx={{ fontWeight: 600, mr: 1 }}>{key}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t('proxies.page.chain.smart.regionHealthy', {
                      count: health?.healthyCount ?? 0,
                    })}
                  </Typography>
                </MenuItem>
              )
            })}
          </Select>

          <ArrowForward
            sx={{ fontSize: 18, color: theme.palette.text.secondary }}
          />

          <Autocomplete
            size="small"
            options={allUsableNodes}
            value={wizardExit}
            onChange={(_e, value) => setWizardExit(value)}
            sx={{ minWidth: 220, flex: 1 }}
            renderInput={(params) => (
              <TextField
                {...params}
                placeholder={t('proxies.page.chain.smart.wizard.exitNode')}
              />
            )}
          />

          <Button
            size="small"
            variant="contained"
            color="success"
            disabled={!wizardRegion || !wizardExit || busy}
            onClick={handleQuickConnect}
          >
            {t('proxies.page.chain.smart.wizard.connect')}
          </Button>
        </Box>
      </Box>

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ mb: 0.5, display: 'block' }}
      >
        {t('proxies.page.chain.smart.wizard.advancedHint')}
      </Typography>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mb: 2,
          flexWrap: 'wrap',
        }}
      >
        <Select
          size="small"
          displayEmpty
          value={pendingRegion}
          onChange={(e) => setPendingRegion(e.target.value)}
          sx={{ minWidth: 200 }}
        >
          <MenuItem value="" disabled>
            {t('proxies.page.chain.smart.addRegion')}
          </MenuItem>
          {REGION_PATTERNS.map(({ key }) => {
            const health = regionHealth[key]
            return (
              <MenuItem
                key={key}
                value={key}
                disabled={usedRegions.includes(key)}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    width: '100%',
                  }}
                >
                  <Typography sx={{ fontWeight: 600 }}>{key}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t('proxies.page.chain.smart.regionHealthy', {
                      count: health?.healthyCount ?? 0,
                    })}
                  </Typography>
                  {health?.bestNode && health.delay !== undefined && (
                    <Typography variant="caption" color="text.secondary">
                      {t('proxies.page.chain.smart.regionBest', {
                        delay: health.delay,
                      })}
                    </Typography>
                  )}
                </Box>
              </MenuItem>
            )
          })}
        </Select>

        <Button
          size="small"
          variant="outlined"
          onClick={addRegion}
          disabled={!pendingRegion}
        >
          {t('proxies.page.chain.smart.addRegion')}
        </Button>
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mb: 2,
          flexWrap: 'wrap',
        }}
      >
        <Autocomplete
          size="small"
          options={nodeOptions}
          value={pendingNode}
          onChange={(_e, value) => setPendingNode(value)}
          sx={{ minWidth: 240, flex: 1 }}
          renderInput={(params) => (
            <TextField
              {...params}
              label={t('proxies.page.chain.smart.pinExitNode')}
              placeholder={t('proxies.page.chain.smart.pinExitNodeHint')}
            />
          )}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={<PushPinIcon sx={{ fontSize: 16 }} />}
          onClick={addPinned}
          disabled={!pendingNode}
        >
          {t('proxies.page.chain.smart.pinExit')}
        </Button>
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mb: 2,
          flexWrap: 'wrap',
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {t('proxies.page.chain.smart.templates')}
        </Typography>
        {TEMPLATES.map((template) => (
          <Button
            key={template.join('-')}
            size="small"
            variant="text"
            onClick={() => applyTemplate(template)}
          >
            {template.join(' → ')}
          </Button>
        ))}
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto' }}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={resolvedGroups.map((g) => hopId(g))}
            strategy={verticalListSortingStrategy}
          >
            {resolvedGroups.map((group, index) => (
              <Box key={hopId(group)}>
                <HopRow
                  group={group}
                  index={index}
                  delay={delayFor(group.bestNode)}
                  now={hopStatus[index]?.now}
                  onRemove={handleRemove}
                />
                {index < resolvedGroups.length - 1 && (
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
          </SortableContext>
        </DndContext>
      </Box>

      {connected && chainDown && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {t('proxies.page.chain.smart.allDownHint')}
        </Alert>
      )}

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 1,
          mt: 2,
        }}
      >
        {resolvedGroups.length > 0 && (
          <IconButton
            size="small"
            onClick={refreshHealth}
            disabled={refreshing}
            title={t('proxies.page.chain.smart.refreshHealth')}
            sx={{
              color: theme.palette.primary.main,
              mr: 'auto',
              '&:hover': {
                backgroundColor: theme.palette.primary.light + '20',
              },
            }}
          >
            <RefreshIcon
              fontSize="small"
              sx={{
                animation: refreshing
                  ? 'smart-chain-refresh-spin 1s linear infinite'
                  : undefined,
                '@keyframes smart-chain-refresh-spin': {
                  from: { transform: 'rotate(0deg)' },
                  to: { transform: 'rotate(360deg)' },
                },
              }}
            />
          </IconButton>
        )}
        {/* 已连接：只显示"在线/离线"实时状态；未连接：显示下一步提示，状态精简不堆叠 */}
        {connected ? (
          <Chip
            label={liveMeta.label}
            size="small"
            color={liveMeta.color}
            variant={liveStatus === 'idle' ? 'outlined' : 'filled'}
            sx={{ fontWeight: 600 }}
          />
        ) : (
          nextStepHint && (
            <Typography
              variant="caption"
              sx={{ color: nextStepHint.color, mr: 1 }}
            >
              {nextStepHint.text}
            </Typography>
          )
        )}
        {connected ? (
          <Button
            variant="contained"
            color="error"
            onClick={handleDisconnect}
            disabled={busy}
          >
            {t('proxies.page.chain.smart.disconnect')}
          </Button>
        ) : (
          <Button
            variant="contained"
            color="success"
            onClick={handleConnect}
            disabled={connectDisabled}
          >
            {t('proxies.page.chain.smart.connect')}
          </Button>
        )}
      </Box>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>
          {t('proxies.page.chain.smart.switchConfirmTitle')}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {t('proxies.page.chain.smart.switchConfirmFromManual')}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>
            {t('shared.actions.cancel')}
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={handleConfirmSwitch}
          >
            {t('proxies.page.chain.smart.switchConfirmOk')}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  )
}
