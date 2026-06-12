import {
  BookmarkAddOutlined,
  BoltRounded,
  DeleteOutlined,
  EditOutlined,
  PlayArrowRounded,
  SettingsRounded,
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
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material'
import { nanoid } from 'nanoid'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  closeAllConnections,
  selectNodeForGroup,
} from 'tauri-plugin-mihomo-api'

import { useVerge } from '@/hooks/use-verge'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import { updateProxyChainConfigInRuntime } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { patchChainState } from '@/services/proxy-chain-storage'
import {
  extractKeyword,
  resolvePreset,
  type ResolvedHop,
} from '@/utils/chain-preset-match'

interface ChainNode {
  id: string
  name: string
  type?: string
  delay?: number
}

interface Props {
  currentChain: ChainNode[]
  mode: string
  selectedGroup?: string | null
  onApplyChain: (chain: ChainNode[]) => void
}

const buildChainNodes = (names: string[], records: Record<string, any> | undefined): ChainNode[] => {
  const ts = Date.now()
  return names.map((name, i) => ({
    id: `${name}_${ts}_${i}`,
    name,
    type: records?.[name]?.type,
  }))
}

export const ProxyChainPresets = ({
  currentChain,
  mode,
  selectedGroup,
  onApplyChain,
}: Props) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const { verge, patchVerge } = useVerge()
  const { proxies } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()

  const presets = useMemo<IProxyChainPreset[]>(
    () => verge?.proxy_chain_presets ?? [],
    [verge?.proxy_chain_presets],
  )

  const [selectedId, setSelectedId] = useState<string>('')
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [manageDialogOpen, setManageDialogOpen] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState<{
    hops: ResolvedHop[]
    connect: boolean
    presetId: string
  } | null>(null)
  const [saveName, setSaveName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)

  const writePresets = useCallback(
    (next: IProxyChainPreset[]) =>
      patchVerge({ proxy_chain_presets: next }),
    [patchVerge],
  )

  const performConnect = useCallback(
    async (names: string[], targetGroup: string) => {
      await updateProxyChainConfigInRuntime(names)
      const lastName = names[names.length - 1]
      await selectNodeForGroup(targetGroup, lastName)
      patchChainState({ group: targetGroup, exitNode: lastName })
      await closeAllConnections()
      await refreshProxy()
    },
    [refreshProxy],
  )

  const applyResolved = useCallback(
    async (hops: ResolvedHop[], preset: IProxyChainPreset, connect: boolean) => {
      const names = hops.map((h) => h.resolvedName!).filter(Boolean) as string[]
      const chain = buildChainNodes(names, proxies?.records)
      onApplyChain(chain)

      if (connect) {
        const targetGroup =
          mode === 'global' ? 'GLOBAL' : preset.target_group || selectedGroup
        if (!targetGroup) {
          showNotice.error('proxies.page.chain.presets.feedback.noTargetGroup')
          return
        }
        try {
          await performConnect(names, targetGroup)
          showNotice.success('proxies.page.chain.presets.feedback.connected', {
            name: preset.name,
          })
        } catch (e) {
          console.error(e)
          showNotice.error(e)
          return
        }
      }

      const updated: IProxyChainPreset[] = presets.map((p) =>
        p.id === preset.id ? { ...p, last_used_at: Date.now() } : p,
      )
      void writePresets(updated)
    },
    [
      proxies?.records,
      onApplyChain,
      mode,
      selectedGroup,
      performConnect,
      presets,
      writePresets,
    ],
  )

  const handleApply = useCallback(
    async (presetId: string, connect: boolean) => {
      const preset = presets.find((p) => p.id === presetId)
      if (!preset) return

      const hops = resolvePreset(preset.nodes, proxies?.records)
      const missing = hops.filter((h) => h.matchType === 'miss')
      const fallbacks = hops.filter((h) => h.matchType === 'keyword')

      if (missing.length) {
        showNotice.error('proxies.page.chain.presets.feedback.missingNodes', {
          count: missing.length,
        })
        setManageDialogOpen(true)
        return
      }

      if (fallbacks.length > 0) {
        setConfirmDialog({ hops, connect, presetId })
        return
      }

      setBusy(true)
      try {
        await applyResolved(hops, preset, connect)
      } finally {
        setBusy(false)
      }
    },
    [presets, proxies?.records, applyResolved],
  )

  const handleSave = useCallback(async () => {
    const trimmed = saveName.trim()
    if (!trimmed) {
      showNotice.error('proxies.page.chain.presets.feedback.emptyName')
      return
    }
    if (currentChain.length < 2) {
      showNotice.error('proxies.page.chain.minimumNodes')
      return
    }
    const targetGroup =
      mode === 'global' ? 'GLOBAL' : selectedGroup ?? undefined
    const preset: IProxyChainPreset = {
      id: nanoid(),
      name: trimmed,
      nodes: currentChain.map((n) => ({
        name: n.name,
        keyword: extractKeyword(n.name),
      })),
      hops: currentChain.map((n) => {
        const kw = extractKeyword(n.name)
        return kw
          ? { kind: 'region' as const, value: kw }
          : { kind: 'pinned' as const, value: n.name }
      }),
      target_group: targetGroup,
      created_at: Date.now(),
    }
    await writePresets([...presets, preset])
    setSaveName('')
    setSaveDialogOpen(false)
    setSelectedId(preset.id)
    showNotice.success('proxies.page.chain.presets.feedback.saved', {
      name: trimmed,
    })
  }, [saveName, currentChain, mode, selectedGroup, presets, writePresets])

  const handleDelete = useCallback(
    async (id: string) => {
      const next = presets.filter((p) => p.id !== id)
      await writePresets(next)
      if (selectedId === id) setSelectedId('')
    },
    [presets, writePresets, selectedId],
  )

  const handleRename = useCallback(
    async (id: string) => {
      const trimmed = renameValue.trim()
      if (!trimmed) return
      const next = presets.map((p) =>
        p.id === id ? { ...p, name: trimmed } : p,
      )
      await writePresets(next)
      setRenamingId(null)
      setRenameValue('')
    },
    [presets, writePresets, renameValue],
  )

  const confirmFallback = useCallback(async () => {
    if (!confirmDialog) return
    const preset = presets.find((p) => p.id === confirmDialog.presetId)
    if (!preset) return
    setBusy(true)
    try {
      await applyResolved(confirmDialog.hops, preset, confirmDialog.connect)
      setConfirmDialog(null)
    } finally {
      setBusy(false)
    }
  }, [confirmDialog, presets, applyResolved])

  const canSave = currentChain.length >= 2
  const noPreset = presets.length === 0
  const targetReady = mode === 'global' || !!selectedGroup

  return (
    <Box sx={{ mb: 1.5 }}>
      <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 1 }}>
        <Select
          size="small"
          displayEmpty
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={noPreset}
          sx={{ flex: 1, minWidth: 0 }}
        >
          <MenuItem value="" disabled>
            {noPreset
              ? t('proxies.page.chain.presets.empty')
              : t('proxies.page.chain.presets.placeholder')}
          </MenuItem>
          {presets.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.name}
              <Chip
                size="small"
                label={p.nodes.length}
                sx={{ ml: 1, height: 18 }}
              />
            </MenuItem>
          ))}
        </Select>

        <Tooltip
          title={t('proxies.page.chain.presets.actions.applyAndConnect')}
        >
          <span>
            <Button
              size="small"
              variant="contained"
              color="success"
              startIcon={<BoltRounded />}
              disabled={!selectedId || busy || !targetReady}
              onClick={() => handleApply(selectedId, true)}
              sx={{ minWidth: 90 }}
            >
              {t('proxies.page.chain.presets.actions.oneClick')}
            </Button>
          </span>
        </Tooltip>

        <Tooltip title={t('proxies.page.chain.presets.actions.applyOnly')}>
          <span>
            <IconButton
              size="small"
              disabled={!selectedId || busy}
              onClick={() => handleApply(selectedId, false)}
              sx={{ color: theme.palette.primary.main }}
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
          {t('proxies.page.chain.presets.dialogs.saveTitle')}
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
              count: currentChain.length,
            })}
          </Typography>
          <List dense sx={{ mt: 1 }}>
            {currentChain.map((node, i) => {
              const kw = extractKeyword(node.name)
              return (
                <ListItem key={node.id} disablePadding sx={{ py: 0.25 }}>
                  <ListItemText
                    primary={`${i + 1}. ${node.name}`}
                    secondary={
                      kw
                        ? t(
                            'proxies.page.chain.presets.dialogs.keywordPreview',
                            { keyword: kw },
                          )
                        : t('proxies.page.chain.presets.dialogs.noKeyword')
                    }
                    slotProps={{
                      primary: { variant: 'body2' },
                      secondary: { variant: 'caption' },
                    }}
                  />
                </ListItem>
              )
            })}
          </List>
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
          {presets.length === 0 ? (
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
                      primary={p.name}
                      secondary={t(
                        'proxies.page.chain.presets.dialogs.manageMeta',
                        {
                          count: p.nodes.length,
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

      <Dialog
        open={!!confirmDialog}
        onClose={() => setConfirmDialog(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {t('proxies.page.chain.presets.dialogs.fallbackTitle')}
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t('proxies.page.chain.presets.dialogs.fallbackHint')}
          </Typography>
          <List dense>
            {confirmDialog?.hops.map((h, i) => (
              <ListItem key={i} disablePadding sx={{ py: 0.5 }}>
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 1 }}>
                      <Chip
                        size="small"
                        label={i + 1}
                        sx={{ minWidth: 24, height: 20 }}
                      />
                      <Typography
                        variant="body2"
                        sx={{ textDecoration: 'line-through', opacity: 0.6 }}
                      >
                        {h.presetName}
                      </Typography>
                      <Typography variant="body2">→</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {h.resolvedName}
                      </Typography>
                      <Chip
                        size="small"
                        label={
                          h.matchType === 'exact'
                            ? t(
                                'proxies.page.chain.presets.matchType.exact',
                              )
                            : t(
                                'proxies.page.chain.presets.matchType.keyword',
                                { keyword: h.presetKeyword || '?' },
                              )
                        }
                        color={h.matchType === 'exact' ? 'success' : 'warning'}
                        sx={{ height: 18 }}
                      />
                    </Box>
                  }
                />
              </ListItem>
            ))}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDialog(null)} disabled={busy}>
            {t('shared.actions.cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void confirmFallback()}
            disabled={busy}
          >
            {confirmDialog?.connect
              ? t('proxies.page.chain.presets.actions.oneClick')
              : t('proxies.page.chain.presets.actions.applyOnly')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
