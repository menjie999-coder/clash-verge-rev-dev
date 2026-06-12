const STORAGE_KEY = 'proxy-chain-state'

const LEGACY_KEYS = {
  enabled: 'proxy-chain-mode-enabled',
  items: 'proxy-chain-items',
  group: 'proxy-chain-group',
  exitNode: 'proxy-chain-exit-node',
} as const

export interface ProxyChainItem {
  id: string
  name: string
  type?: string
  delay?: number
}

export interface ProxyChainState {
  enabled: boolean
  items: ProxyChainItem[]
  group: string | null
  exitNode: string | null
  hops?: IChainHop[]
}

const EMPTY: ProxyChainState = {
  enabled: false,
  items: [],
  group: null,
  exitNode: null,
}

function readLegacy(): ProxyChainState {
  try {
    const enabled = localStorage.getItem(LEGACY_KEYS.enabled) === 'true'
    const itemsRaw = localStorage.getItem(LEGACY_KEYS.items)
    const group = localStorage.getItem(LEGACY_KEYS.group)
    const exitNode = localStorage.getItem(LEGACY_KEYS.exitNode)
    const items: ProxyChainItem[] = itemsRaw ? JSON.parse(itemsRaw) : []
    return {
      enabled,
      items: Array.isArray(items) ? items : [],
      group,
      exitNode,
    }
  } catch {
    return { ...EMPTY }
  }
}

function clearLegacy() {
  try {
    Object.values(LEGACY_KEYS).forEach((k) => localStorage.removeItem(k))
  } catch {
    // ignore
  }
}

export function readChainState(): ProxyChainState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProxyChainState>
      return {
        enabled: !!parsed.enabled,
        items: Array.isArray(parsed.items) ? parsed.items : [],
        group: typeof parsed.group === 'string' ? parsed.group : null,
        exitNode: typeof parsed.exitNode === 'string' ? parsed.exitNode : null,
        hops: Array.isArray(parsed.hops) ? parsed.hops : undefined,
      }
    }

    const legacy = readLegacy()
    if (
      legacy.enabled ||
      legacy.items.length > 0 ||
      legacy.group ||
      legacy.exitNode
    ) {
      writeChainState(legacy)
      clearLegacy()
      return legacy
    }
  } catch {
    // ignore
  }
  return { ...EMPTY }
}

export function writeChainState(state: ProxyChainState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

export function patchChainState(
  patch: Partial<ProxyChainState>,
): ProxyChainState {
  const next = { ...readChainState(), ...patch }
  writeChainState(next)
  return next
}

export function clearChainConnection(): void {
  patchChainState({ items: [], group: null, exitNode: null })
}
