import { describe, expect, it } from 'vitest'
import { buildSmartChainPayload, DEFAULT_HEALTH_URL } from './chain-config-builder'
import type { ResolvedHopGroup } from './chain-resolver'

const grp = (i: number, candidates: string[]): ResolvedHopGroup => ({
  hopIndex: i,
  groupName: `__CHAIN_HOP_${i}`,
  kind: 'region',
  value: 'HK',
  candidates,
  bestNode: candidates[0] ?? null,
  healthyCount: candidates.length,
})

describe('buildSmartChainPayload', () => {
  it('maps resolved groups to url-test group specs with the target group', () => {
    const payload = buildSmartChainPayload(
      [grp(0, ['HK-1', 'HK-2']), grp(1, ['JP-1'])],
      'GLOBAL',
      { healthUrl: DEFAULT_HEALTH_URL, interval: 60, tolerance: 50 },
    )
    expect(payload.target_group).toBe('GLOBAL')
    expect(payload.hops).toHaveLength(2)
    expect(payload.hops[0]).toEqual({
      name: '__CHAIN_HOP_0',
      type: 'url-test',
      proxies: ['HK-1', 'HK-2'],
      url: DEFAULT_HEALTH_URL,
      interval: 60,
      tolerance: 50,
    })
  })

  it('throws when any hop has zero candidates (cannot build a dead chain)', () => {
    expect(() =>
      buildSmartChainPayload([grp(0, ['HK-1']), grp(1, [])], 'GLOBAL', {
        healthUrl: DEFAULT_HEALTH_URL,
        interval: 60,
        tolerance: 50,
      }),
    ).toThrow(/no healthy/i)
  })
})
