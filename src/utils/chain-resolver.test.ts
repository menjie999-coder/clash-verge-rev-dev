import { describe, expect, it } from 'vitest'

import { CHAIN_HOP_GROUP_PREFIX, resolveChainGroups } from './chain-resolver'

const rec = (name: string, delay: number, type = 'ss') => ({
  name,
  type,
  history: [{ time: '', delay }],
})

const records = {
  'HK-fast': rec('HK 香港 01', 80),
  'HK-slow': rec('HK 香港 02', 300),
  'HK-dead': rec('HK 香港 03', 0),
  'JP-1': rec('JP 日本 01', 120),
  'US-1': rec('US 美国 01', 200),
  Selector: { name: 'Selector', type: 'Selector' },
}
const byName = Object.fromEntries(Object.values(records).map((r) => [r.name, r]))

describe('resolveChainGroups', () => {
  it('builds one url-test group per region hop with healthy candidates sorted by delay', () => {
    const groups = resolveChainGroups(
      [{ kind: 'region', value: 'HK' }, { kind: 'region', value: 'JP' }],
      byName,
      { timeout: 10000 },
    )
    expect(groups).toHaveLength(2)
    expect(groups[0].groupName).toBe(`${CHAIN_HOP_GROUP_PREFIX}0`)
    expect(groups[0].candidates).toEqual(['HK 香港 01', 'HK 香港 02'])
    expect(groups[0].bestNode).toBe('HK 香港 01')
    expect(groups[1].groupName).toBe(`${CHAIN_HOP_GROUP_PREFIX}1`)
    expect(groups[1].candidates).toEqual(['JP 日本 01'])
  })

  it('excludes proxy groups / built-ins from candidates', () => {
    const groups = resolveChainGroups([{ kind: 'region', value: 'HK' }], byName, {
      timeout: 10000,
    })
    expect(groups[0].candidates).not.toContain('Selector')
  })

  it('first-claim dedup: a node used in an earlier hop is not reused in a later hop', () => {
    const groups = resolveChainGroups(
      [{ kind: 'filter', value: '香港' }, { kind: 'filter', value: '01' }],
      byName,
      { timeout: 10000 },
    )
    expect(groups[0].candidates).toContain('HK 香港 01')
    expect(groups[1].candidates).not.toContain('HK 香港 01')
  })

  it('pinned hop yields a single-node group', () => {
    const groups = resolveChainGroups([{ kind: 'pinned', value: 'US 美国 01' }], byName, {
      timeout: 10000,
    })
    expect(groups[0].candidates).toEqual(['US 美国 01'])
    expect(groups[0].kind).toBe('pinned')
  })

  it('marks a hop with zero healthy candidates', () => {
    const groups = resolveChainGroups([{ kind: 'region', value: 'DE' }], byName, {
      timeout: 10000,
    })
    expect(groups[0].candidates).toEqual([])
    expect(groups[0].healthyCount).toBe(0)
    expect(groups[0].bestNode).toBeNull()
  })
})
