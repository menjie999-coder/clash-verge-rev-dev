import {
  isUsableNode,
  latestDelay,
  REGION_PATTERNS,
  type MatchableProxy,
} from './chain-preset-match'

export const CHAIN_HOP_GROUP_PREFIX = '__CHAIN_HOP_'

export interface ResolveOptions {
  timeout: number
}

export interface ResolvedHopGroup {
  hopIndex: number
  groupName: string
  kind: 'region' | 'filter' | 'pinned'
  value: string
  candidates: string[]
  bestNode: string | null
  healthyCount: number
}

const groupName = (i: number) => `${CHAIN_HOP_GROUP_PREFIX}${i}`

const matchHop = (
  proxy: MatchableProxy,
  hop: { kind: string; value: string },
): boolean => {
  if (hop.kind === 'pinned') return proxy.name === hop.value
  if (hop.kind === 'region') {
    const pattern = REGION_PATTERNS.find((p) => p.key === hop.value)
    return pattern ? pattern.regex.test(proxy.name) : false
  }
  return proxy.name.toLowerCase().includes(hop.value.toLowerCase())
}

const isHealthy = (proxy: MatchableProxy, timeout: number): boolean => {
  const d = latestDelay(proxy)
  return d !== undefined && d > 0 && d < timeout
}

export function resolveChainGroups(
  hops: { kind: 'region' | 'filter' | 'pinned'; value: string }[],
  records: Record<string, MatchableProxy> | undefined,
  opts: ResolveOptions,
): ResolvedHopGroup[] {
  const all = Object.values(records ?? {}).filter(isUsableNode)
  const claimed = new Set<string>()

  return hops.map((hop, hopIndex) => {
    const candidates = all
      .filter(
        (p) =>
          !claimed.has(p.name) &&
          matchHop(p, hop) &&
          (hop.kind === 'pinned' || isHealthy(p, opts.timeout)),
      )
      .sort((a, b) => {
        const da = latestDelay(a) ?? Number.POSITIVE_INFINITY
        const db = latestDelay(b) ?? Number.POSITIVE_INFINITY
        return da === db ? a.name.localeCompare(b.name) : da - db
      })

    candidates.forEach((p) => claimed.add(p.name))
    const names = candidates.map((p) => p.name)

    return {
      hopIndex,
      groupName: groupName(hopIndex),
      kind: hop.kind,
      value: hop.value,
      candidates: names,
      bestNode: names[0] ?? null,
      healthyCount: names.length,
    }
  })
}
