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
  ArrowForward,
  Delete as DeleteIcon,
  DragIndicator,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Typography,
  useTheme,
} from '@mui/material'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useSmartChain } from '@/hooks/use-smart-chain'
import { useVerge } from '@/hooks/use-verge'
import { useProxiesData } from '@/providers/app-data-context'
import { showNotice } from '@/services/notice-service'
import { readChainState } from '@/services/proxy-chain-storage'
import { latestDelay, REGION_PATTERNS } from '@/utils/chain-preset-match'
import {
  resolveChainGroups,
  type ResolvedHopGroup,
} from '@/utils/chain-resolver'

const TEMPLATES: string[][] = [
  ['HK', 'US'],
  ['HK', 'JP', 'US'],
]

interface SmartChainBuilderProps {
  mode: string
  selectedGroup?: string | null
}

interface HopRowProps {
  group: ResolvedHopGroup
  index: number
  delay?: number
  now?: string | null
  onRemove: (index: number) => void
}

const hopId = (group: ResolvedHopGroup) => `hop-${group.hopIndex}-${group.value}`

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

export const SmartChainBuilder = ({
  mode,
  selectedGroup,
}: SmartChainBuilderProps) => {
  const theme = useTheme()
  const { t } = useTranslation()
  const {
    hops,
    setHops,
    resolvedGroups,
    hopStatus,
    overallStatus,
    connect,
    disconnect,
    busy,
    targetGroup,
  } = useSmartChain(mode, selectedGroup)
  const { proxies } = useProxiesData()
  const { verge } = useVerge()
  const timeout = verge?.default_latency_timeout || 10000

  const [pendingRegion, setPendingRegion] = useState('')
  const [connected, setConnected] = useState<boolean>(() => {
    const s = readChainState()
    return !!s.group && (s.hops?.length ?? 0) >= 2
  })

  const usedRegions = useMemo(
    () =>
      hops.filter((h) => h.kind === 'region').map((h) => h.value),
    [hops],
  )

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
      const oldIndex = resolvedGroups.findIndex(
        (g) => hopId(g) === active.id,
      )
      const newIndex = resolvedGroups.findIndex((g) => hopId(g) === over.id)
      if (oldIndex < 0 || newIndex < 0) return
      setHops(arrayMove(hops, oldIndex, newIndex))
    },
    [resolvedGroups, hops, setHops],
  )

  const handleConnect = useCallback(async () => {
    const ok = await connect()
    if (ok) setConnected(true)
  }, [connect])

  const handleDisconnect = useCallback(async () => {
    await disconnect()
    setConnected(false)
  }, [disconnect])

  const connectDisabled =
    hops.length < 2 ||
    !targetGroup ||
    resolvedGroups.some((g) => g.healthyCount === 0) ||
    busy

  return (
    <Paper
      elevation={1}
      sx={{ height: '100%', p: 2, display: 'flex', flexDirection: 'column' }}
    >
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
          <Chip
            label={t(`proxies.page.chain.smart.status.${overallStatus}`)}
            size="small"
            color={
              overallStatus === 'healthy'
                ? 'success'
                : overallStatus === 'degraded'
                  ? 'warning'
                  : 'error'
            }
          />
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
    </Paper>
  )
}
