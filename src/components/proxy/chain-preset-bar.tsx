import {
  AutoAwesomeRounded,
  BoltRounded,
  BookmarkAddOutlined,
  DeleteOutlined,
  EditOutlined,
  PlayArrowRounded,
  SettingsRounded,
  TuneRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { nanoid } from 'nanoid'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { UseSmartChain } from '@/hooks/use-smart-chain'
import { useVerge } from '@/hooks/use-verge'
import { useProxiesData } from '@/providers/app-data-context'
import { showNotice } from '@/services/notice-service'
import { extractKeyword, resolvePreset } from '@/utils/chain-preset-match'

interface ManualChainNode {
  id: string
  name: string
  type?: string
}

interface Props {
  smart: UseSmartChain
  manualChain: ManualChainNode[]
  uiMode: 'smart' | 'advanced'
  setUiMode: (mode: 'smart' | 'advanced') => void
  mode: string
  selectedGroup?: string | null
  onApplyManual: (names: string[]) => void
  onConnectManual: (names: string[]) => void
}

const presetType = (p: IProxyChainPreset): IChainPresetType => {
  if (p.type) return p.type
  // 回退推断：含"地区/过滤"跳的按智能链处理（手动链的 hops 只会是具体 pinned 节点）。
  if (p.hops?.some((h) => h.kind === 'region' || h.kind === 'filter')) {
    return 'smart'
  }
  return 'manual'
}

/** 兼容老预设：没有 hops 时从 nodes 推导（关键词→地区跳，否则→固定跳）。 */
const presetToHops = (preset: IProxyChainPreset): IChainHop[] => {
  if (preset.hops?.length) return preset.hops
  return preset.nodes.map((n) =>
    n.keyword
      ? { kind: 'region' as const, value: n.keyword }
      : { kind: 'pinned' as const, value: n.name },
  )
}

export const ChainPresetBar = ({
  smart,
  manualChain,
  uiMode,
  setUiMode,
  mode,
  selectedGroup,
  onApplyManual,
  onConnectManual,
}: Props) => {
  const { t } = useTranslation()
  const { verge, patchVerge } = useVerge()
  const { proxies } = useProxiesData()

  const presets = useMemo<IProxyChainPreset[]>(
    () => verge?.proxy_chain_presets ?? [],
    [verge?.proxy_chain_presets],
  )
  const smartPresets = useMemo(
    () => presets.filter((p) => presetType(p) === 'smart'),
    [presets],
  )
  const manualPresets = useMemo(
    () => presets.filter((p) => presetType(p) === 'manual'),
    [presets],
  )

  const [selectedId, setSelectedId] = useState<string>('')
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [manageDialogOpen, setManageDialogOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const writePresets = useCallback(
    (next: IProxyChainPreset[]) => patchVerge({ proxy_chain_presets: next }),
    [patchVerge],
  )

  const touchLastUsed = useCallback(
    (id: string) =>
      void writePresets(
        presets.map((p) =>
          p.id === id ? { ...p, last_used_at: Date.now() } : p,
        ),
      ),
    [presets, writePresets],
  )

  const targetReady = mode === 'global' || !!selectedGroup

  // 解析手动链预设为具体节点名；缺失则提示并返回 null。
  const resolveManualNames = useCallback(
    (preset: IProxyChainPreset): string[] | null => {
      const resolved = resolvePreset(preset.nodes, proxies?.records)
      const missing = resolved.filter((h) => h.matchType === 'miss')
      if (missing.length) {
        showNotice.error('proxies.page.chain.presets.feedback.missingNodes', {
          count: missing.length,
        })
        return null
      }
      return resolved.map((h) => h.resolvedName).filter((n): n is string => !!n)
    },
    [proxies?.records],
  )

  // 仅应用（填充，不连接），方便先复核再手动连接。
  const handleApplyOnly = useCallback(() => {
    const preset = presets.find((p) => p.id === selectedId)
    if (!preset) return
    if (presetType(preset) === 'smart') {
      setUiMode('smart')
      smart.setHops(presetToHops(preset))
      touchLastUsed(preset.id)
      return
    }
    const names = resolveManualNames(preset)
    if (!names) return
    setUiMode('advanced')
    onApplyManual(names)
    touchLastUsed(preset.id)
  }, [
    presets,
    selectedId,
    setUiMode,
    smart,
    resolveManualNames,
    onApplyManual,
    touchLastUsed,
  ])

  // 一键应用并连接（傻瓜式）。未选代理组时退回"仅应用"并提示。
  const handleApplyConnect = useCallback(() => {
    const preset = presets.find((p) => p.id === selectedId)
    if (!preset) return
    if (!targetReady) {
      showNotice.error('proxies.page.chain.presets.feedback.noTargetGroup')
      handleApplyOnly()
      return
    }
    if (presetType(preset) === 'smart') {
      setUiMode('smart')
      // 平切：已连接时切换链路不强制断流。
      void smart.connect(presetToHops(preset), { seamless: smart.connected })
      touchLastUsed(preset.id)
      return
    }
    const names = resolveManualNames(preset)
    if (!names) return
    setUiMode('advanced')
    onConnectManual(names)
    touchLastUsed(preset.id)
  }, [
    presets,
    selectedId,
    targetReady,
    handleApplyOnly,
    setUiMode,
    smart,
    resolveManualNames,
    onConnectManual,
    touchLastUsed,
  ])

  const handleSave = useCallback(async () => {
    const trimmed = saveName.trim()
    if (!trimmed) {
      showNotice.error('proxies.page.chain.presets.feedback.emptyName')
      return
    }
    const targetGroup =
      mode === 'global' ? 'GLOBAL' : (selectedGroup ?? undefined)

    let preset: IProxyChainPreset
    if (uiMode === 'smart') {
      const hops = smart.hops
      if (hops.length < 2) {
        showNotice.error('proxies.page.chain.minimumNodes')
        return
      }
      preset = {
        id: nanoid(),
        name: trimmed,
        type: 'smart',
        // nodes 供手动链复用：地区跳保留关键词回退，固定跳保留精确名。
        nodes: hops.map((h) =>
          h.kind === 'pinned'
            ? { name: h.value }
            : { name: '', keyword: h.value },
        ),
        hops: [...hops],
        target_group: targetGroup,
        created_at: Date.now(),
      }
    } else {
      if (manualChain.length < 2) {
        showNotice.error('proxies.page.chain.minimumNodes')
        return
      }
      preset = {
        id: nanoid(),
        name: trimmed,
        type: 'manual',
        nodes: manualChain.map((n) => ({
          name: n.name,
          keyword: extractKeyword(n.name),
        })),
        hops: manualChain.map((n) => {
          const kw = extractKeyword(n.name)
          return kw
            ? { kind: 'region' as const, value: kw }
            : { kind: 'pinned' as const, value: n.name }
        }),
        target_group: targetGroup,
        created_at: Date.now(),
      }
    }

    await writePresets([...presets, preset])
    setSaveName('')
    setSaveDialogOpen(false)
    setSelectedId(preset.id)
    showNotice.success('proxies.page.chain.presets.feedback.saved', {
      name: trimmed,
    })
  }, [
    saveName,
    uiMode,
    smart.hops,
    manualChain,
    mode,
    selectedGroup,
    presets,
    writePresets,
  ])

  const handleDelete = useCallback(
    async (id: string) => {
      await writePresets(presets.filter((p) => p.id !== id))
      if (selectedId === id) setSelectedId('')
    },
    [presets, writePresets, selectedId],
  )

  const handleRename = useCallback(
    async (id: string) => {
      const trimmed = renameValue.trim()
      if (!trimmed) return
      await writePresets(
        presets.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
      )
      setRenamingId(null)
      setRenameValue('')
    },
    [presets, writePresets, renameValue],
  )

  const noPreset = presets.length === 0
  const canSave =
    uiMode === 'smart' ? smart.hops.length >= 2 : manualChain.length >= 2

  const renderOptions = () => {
    const groups: React.ReactNode[] = []
    if (smartPresets.length) {
      groups.push(
        <ListSubheader key="smart-header">
          {t('proxies.page.chain.presets.group.smart')}
        </ListSubheader>,
      )
      smartPresets.forEach((p) =>
        groups.push(
          <MenuItem key={p.id} value={p.id}>
            <AutoAwesomeRounded
              fontSize="small"
              color="success"
              sx={{ mr: 1 }}
            />
            {p.name}
            <Chip
              size="small"
              label={(p.hops?.length ?? p.nodes.length) || 0}
              sx={{ ml: 1, height: 18 }}
            />
          </MenuItem>,
        ),
      )
    }
    if (manualPresets.length) {
      groups.push(
        <ListSubheader key="manual-header">
          {t('proxies.page.chain.presets.group.manual')}
        </ListSubheader>,
      )
      manualPresets.forEach((p) =>
        groups.push(
          <MenuItem key={p.id} value={p.id}>
            <TuneRounded fontSize="small" color="primary" sx={{ mr: 1 }} />
            {p.name}
            <Chip
              size="small"
              label={(p.nodes.length || p.hops?.length) ?? 0}
              sx={{ ml: 1, height: 18 }}
            />
          </MenuItem>,
        ),
      )
    }
    return groups
  }

  return (
    <Box sx={{ mb: 1.5 }}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Select
          size="small"
          displayEmpty
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={noPreset}
          sx={{ flex: 1, minWidth: 0 }}
          renderValue={(val) => {
            const p = presets.find((x) => x.id === val)
            if (!p) {
              return noPreset
                ? t('proxies.page.chain.presets.empty')
                : t('proxies.page.chain.presets.placeholder')
            }
            return p.name
          }}
        >
          <MenuItem value="" disabled>
            {noPreset
              ? t('proxies.page.chain.presets.empty')
              : t('proxies.page.chain.presets.placeholder')}
          </MenuItem>
          {renderOptions()}
        </Select>

        <Tooltip title={t('proxies.page.chain.smart.presetApplyConnect')}>
          <span>
            <Button
              size="small"
              variant="contained"
              color="success"
              startIcon={<BoltRounded />}
              disabled={!selectedId}
              onClick={handleApplyConnect}
              sx={{ minWidth: 100 }}
            >
              {t('proxies.page.chain.smart.presetApplyConnectShort')}
            </Button>
          </span>
        </Tooltip>

        <Tooltip title={t('proxies.page.chain.smart.presetApply')}>
          <span>
            <IconButton
              size="small"
              color="primary"
              disabled={!selectedId}
              onClick={handleApplyOnly}
            >
              <PlayArrowRounded fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('proxies.page.chain.presets.actions.saveCurrent')}>
          <span>
            <IconButton
              size="small"
              disabled={!canSave}
              onClick={() => setSaveDialogOpen(true)}
            >
              <BookmarkAddOutlined fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('proxies.page.chain.presets.actions.manage')}>
          <span>
            <IconButton
              size="small"
              disabled={noPreset}
              onClick={() => setManageDialogOpen(true)}
            >
              <SettingsRounded fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Dialog
        open={saveDialogOpen}
        onClose={() => setSaveDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          {uiMode === 'smart'
            ? t('proxies.page.chain.presets.dialogs.saveTitleSmart')
            : t('proxies.page.chain.presets.dialogs.saveTitleManual')}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label={t('proxies.page.chain.presets.dialogs.nameLabel')}
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSave()
            }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
            {t('proxies.page.chain.presets.dialogs.savePreview', {
              count:
                uiMode === 'smart' ? smart.hops.length : manualChain.length,
            })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveDialogOpen(false)}>
            {t('shared.actions.cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSave()}
            disabled={!saveName.trim()}
          >
            {t('shared.actions.save')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={manageDialogOpen}
        onClose={() => setManageDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {t('proxies.page.chain.presets.dialogs.manageTitle')}
        </DialogTitle>
        <DialogContent dividers>
          {noPreset ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ textAlign: 'center', py: 3 }}
            >
              {t('proxies.page.chain.presets.empty')}
            </Typography>
          ) : (
            <List dense>
              {presets.map((p) => (
                <ListItem
                  key={p.id}
                  secondaryAction={
                    <Stack direction="row" spacing={0.5}>
                      <IconButton
                        size="small"
                        onClick={() => {
                          setRenamingId(p.id)
                          setRenameValue(p.name)
                        }}
                      >
                        <EditOutlined fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => void handleDelete(p.id)}
                      >
                        <DeleteOutlined fontSize="small" />
                      </IconButton>
                    </Stack>
                  }
                >
                  {renamingId === p.id ? (
                    <TextField
                      size="small"
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => void handleRename(p.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRename(p.id)
                        if (e.key === 'Escape') {
                          setRenamingId(null)
                          setRenameValue('')
                        }
                      }}
                    />
                  ) : (
                    <ListItemText
                      primary={
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                          }}
                        >
                          <Chip
                            size="small"
                            color={
                              presetType(p) === 'smart' ? 'success' : 'primary'
                            }
                            label={
                              presetType(p) === 'smart'
                                ? t('proxies.page.chain.presets.group.smart')
                                : t('proxies.page.chain.presets.group.manual')
                            }
                            sx={{ height: 18 }}
                          />
                          <Typography variant="body2">{p.name}</Typography>
                        </Box>
                      }
                      secondary={t(
                        'proxies.page.chain.presets.dialogs.manageMeta',
                        {
                          count: (p.hops?.length ?? p.nodes.length) || 0,
                          group: p.target_group || '—',
                        },
                      )}
                    />
                  )}
                </ListItem>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setManageDialogOpen(false)}>
            {t('shared.actions.close')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
