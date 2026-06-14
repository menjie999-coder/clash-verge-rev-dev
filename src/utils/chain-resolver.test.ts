import { describe, expect, it } from 'vitest'

import {
  CHAIN_HOP_GROUP_PREFIX,
  collectHopMatches,
  resolveChainGroups,
} from './chain-resolver'

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
const byName = Object.fromEntries(
  Object.values(records).map((r) => [r.name, r]),
)

describe('resolveChainGroups', () => {
  it('builds one url-test group per region hop with healthy candidates sorted by delay', () => {
    const groups = resolveChainGroups(
      [
        { kind: 'region', value: 'HK' },
        { kind: 'region', value: 'JP' },
      ],
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
    const groups = resolveChainGroups(
      [{ kind: 'region', value: 'HK' }],
      byName,
      {
        timeout: 10000,
      },
    )
    expect(groups[0].candidates).not.toContain('Selector')
  })

  it('first-claim dedup: a node used in an earlier hop is not reused in a later hop', () => {
    const groups = resolveChainGroups(
      [
        { kind: 'filter', value: '香港' },
        { kind: 'filter', value: '01' },
      ],
      byName,
      { timeout: 10000 },
    )
    expect(groups[0].candidates).toContain('HK 香港 01')
    expect(groups[1].candidates).not.toContain('HK 香港 01')
  })

  it('pinned hop yields a single-node group', () => {
    const groups = resolveChainGroups(
      [{ kind: 'pinned', value: 'US 美国 01' }],
      byName,
      {
        timeout: 10000,
      },
    )
    expect(groups[0].candidates).toEqual(['US 美国 01'])
    expect(groups[0].kind).toBe('pinned')
  })

  it('pinned exit survives even when its direct latency test fails (e.g. a SOCKS5 only reachable through the front hop)', () => {
    // 自导入的 SOCKS5 出口：从客户端直连必然超时（delay 0）或根本没有测速历史，
    // 但它只在经由前置节点时可达。pinned 跳必须忽略"直连健康"，否则用户无法连接。
    const socksRecords = {
      ...byName,
      'pure-socks5': {
        name: 'pure-socks5',
        type: 'socks5',
        history: [{ time: '', delay: 0 }],
      },
      'pure-socks5-nohist': { name: 'pure-socks5-nohist', type: 'socks5' },
    }
    const dead = resolveChainGroups(
      [
        { kind: 'region', value: 'HK' },
        { kind: 'pinned', value: 'pure-socks5' },
      ],
      socksRecords,
      { timeout: 10000 },
    )
    expect(dead[1].candidates).toEqual(['pure-socks5'])
    expect(dead[1].healthyCount).toBe(1)

    const noHistory = resolveChainGroups(
      [
        { kind: 'region', value: 'HK' },
        { kind: 'pinned', value: 'pure-socks5-nohist' },
      ],
      socksRecords,
      { timeout: 10000 },
    )
    expect(noHistory[1].candidates).toEqual(['pure-socks5-nohist'])
    expect(noHistory[1].healthyCount).toBe(1)
  })

  it('collectHopMatches returns all matching nodes incl. dead ones (so refresh can revive them)', () => {
    // HK 香港 03 直连超时（delay 0）→ 不是健康候选，但刷新时必须被重测，否则永远复活不了。
    const names = collectHopMatches([{ kind: 'region', value: 'HK' }], byName)
    expect(names).toEqual(['HK 香港 01', 'HK 香港 02', 'HK 香港 03'])
  })

  it('collectHopMatches keeps first-claim dedup across hops and skips groups', () => {
    const names = collectHopMatches(
      [
        { kind: 'filter', value: '香港' },
        { kind: 'filter', value: '01' },
      ],
      byName,
    )
    // HK 香港 01 被第一跳占用，第二跳的 "01" 不再重复收录它。
    expect(names.filter((n) => n === 'HK 香港 01')).toHaveLength(1)
    expect(names).not.toContain('Selector')
  })

  it('marks a hop with zero healthy candidates', () => {
    const groups = resolveChainGroups(
      [{ kind: 'region', value: 'DE' }],
      byName,
      {
        timeout: 10000,
      },
    )
    expect(groups[0].candidates).toEqual([])
    expect(groups[0].healthyCount).toBe(0)
    expect(groups[0].bestNode).toBeNull()
  })
})
