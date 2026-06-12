import type { ResolvedHopGroup } from './chain-resolver'

export const DEFAULT_HEALTH_URL = 'http://www.gstatic.com/generate_204'

export interface SmartChainHopSpec {
  name: string
  type: 'url-test'
  proxies: string[]
  url: string
  interval: number
  tolerance: number
}

export interface SmartChainPayload {
  target_group: string
  hops: SmartChainHopSpec[]
}

export interface BuildOptions {
  healthUrl: string
  interval: number
  tolerance: number
}

export function buildSmartChainPayload(
  groups: ResolvedHopGroup[],
  targetGroup: string,
  opts: BuildOptions,
): SmartChainPayload {
  const dead = groups.find((g) => g.candidates.length === 0)
  if (dead) {
    throw new Error(
      `hop ${dead.hopIndex} (${dead.value}) has no healthy candidate nodes`,
    )
  }
  return {
    target_group: targetGroup,
    hops: groups.map((g) => ({
      name: g.groupName,
      type: 'url-test',
      proxies: g.candidates,
      url: opts.healthUrl,
      interval: opts.interval,
      tolerance: opts.tolerance,
    })),
  }
}
