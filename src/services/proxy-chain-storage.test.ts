import { describe, expect, it } from 'vitest'

import {
  classifyActiveChain,
  type ProxyChainState,
} from './proxy-chain-storage'

const base: ProxyChainState = {
  enabled: false,
  items: [],
  group: null,
  exitNode: null,
}

describe('classifyActiveChain', () => {
  it('returns "none" when nothing is configured', () => {
    expect(classifyActiveChain(base)).toBe('none')
  })

  it('returns "smart" when a >=2-hop smart chain is stored', () => {
    expect(
      classifyActiveChain({
        ...base,
        group: 'PROXY',
        exitNode: '__CHAIN_HOP_1',
        hops: [
          { kind: 'region', value: 'HK' },
          { kind: 'pinned', value: 'my-socks5' },
        ],
      }),
    ).toBe('smart')
  })

  it('returns "manual" when only an exit node is stored (no hops)', () => {
    expect(
      classifyActiveChain({
        ...base,
        group: 'PROXY',
        exitNode: 'my-socks5',
      }),
    ).toBe('manual')
  })

  it('treats a single-hop remnant as not smart', () => {
    expect(
      classifyActiveChain({
        ...base,
        group: 'PROXY',
        exitNode: 'my-socks5',
        hops: [{ kind: 'region', value: 'HK' }],
      }),
    ).toBe('manual')
  })
})
