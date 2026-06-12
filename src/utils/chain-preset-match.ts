export const REGION_PATTERNS: { key: string; regex: RegExp }[] = [
  { key: 'HK', regex: /🇭🇰|香港|HongKong|Hong\s*Kong|\bHK\b/i },
  { key: 'TW', regex: /🇹🇼|台湾|台灣|Taiwan|\bTW\b/i },
  { key: 'JP', regex: /🇯🇵|日本|东京|大阪|Japan|Tokyo|Osaka|\bJP\b/i },
  { key: 'KR', regex: /🇰🇷|韩国|首尔|Korea|Seoul|\bKR\b/i },
  { key: 'SG', regex: /🇸🇬|新加坡|狮城|Singapore|\bSG\b/i },
  { key: 'US', regex: /🇺🇸|美国|美西|美东|纽约|洛杉矶|硅谷|United\s*States|\bUSA?\b/i },
  { key: 'UK', regex: /🇬🇧|英国|伦敦|United\s*Kingdom|London|\bUK\b|\bGB\b/i },
  { key: 'DE', regex: /🇩🇪|德国|法兰克福|Germany|Frankfurt|\bDE\b/i },
  { key: 'FR', regex: /🇫🇷|法国|巴黎|France|Paris|\bFR\b/i },
  { key: 'CA', regex: /🇨🇦|加拿大|多伦多|Canada|Toronto|\bCA\b/i },
  { key: 'AU', regex: /🇦🇺|澳大利亚|悉尼|Australia|Sydney|\bAU\b/i },
  { key: 'NL', regex: /🇳🇱|荷兰|阿姆斯特丹|Netherlands|Amsterdam|\bNL\b/i },
  { key: 'RU', regex: /🇷🇺|俄罗斯|莫斯科|Russia|Moscow|\bRU\b/i },
  { key: 'TR', regex: /🇹🇷|土耳其|Turkey|\bTR\b/i },
  { key: 'IN', regex: /🇮🇳|印度|India|\bIN\b/i },
  { key: 'BR', regex: /🇧🇷|巴西|Brazil|\bBR\b/i },
  { key: 'AR', regex: /🇦🇷|阿根廷|Argentina|\bAR\b/i },
  { key: 'TH', regex: /🇹🇭|泰国|Thailand|\bTH\b/i },
  { key: 'VN', regex: /🇻🇳|越南|Vietnam|\bVN\b/i },
  { key: 'PH', regex: /🇵🇭|菲律宾|Philippines|\bPH\b/i },
  { key: 'MY', regex: /🇲🇾|马来|Malaysia|\bMY\b/i },
  { key: 'ID', regex: /🇮🇩|印尼|Indonesia|\bID\b/i },
]

const GROUP_TYPES = new Set([
  'Selector',
  'URLTest',
  'Fallback',
  'LoadBalance',
  'Relay',
  'Smart',
  'Direct',
  'Reject',
  'Compatible',
  'Pass',
])

export interface MatchableProxy {
  name: string
  type?: string
  history?: { time: string; delay: number }[]
}

export type MatchType = 'exact' | 'keyword' | 'miss'

export interface ResolvedHop {
  presetName: string
  presetKeyword?: string
  resolvedName: string | null
  matchType: MatchType
  delay?: number
}

/** 从节点名抽取最显眼的"地区/关键词"作为预设的回退匹配条件。 */
export function extractKeyword(name: string): string | undefined {
  for (const { key, regex } of REGION_PATTERNS) {
    if (regex.test(name)) {
      return key
    }
  }
  return undefined
}

export const latestDelay = (proxy: MatchableProxy | undefined): number | undefined => {
  if (!proxy?.history?.length) return undefined
  const d = proxy.history[proxy.history.length - 1]?.delay
  return typeof d === 'number' ? d : undefined
}

/** 节点是否为可被链式代理串联的"真实节点"(排除策略组和内置项)。 */
export const isUsableNode = (proxy: MatchableProxy): boolean => {
  if (!proxy.type) return true
  return !GROUP_TYPES.has(proxy.type)
}

const matchByKeyword = (proxy: MatchableProxy, keyword: string): boolean => {
  const pattern = REGION_PATTERNS.find((p) => p.key === keyword)
  if (pattern) return pattern.regex.test(proxy.name)
  return proxy.name.toLowerCase().includes(keyword.toLowerCase())
}

const pickByLowestDelay = (
  candidates: MatchableProxy[],
): MatchableProxy | undefined => {
  if (!candidates.length) return undefined
  let best: MatchableProxy | undefined
  let bestDelay = Number.POSITIVE_INFINITY
  for (const p of candidates) {
    const d = latestDelay(p)
    if (d !== undefined && d > 0 && d < bestDelay) {
      bestDelay = d
      best = p
    }
  }
  return best ?? candidates[0]
}

/** 对一个预设逐跳解析:精确名 → 关键词 + 最低延迟 → miss。 */
export function resolvePreset(
  presetNodes: { name: string; keyword?: string }[],
  records: Record<string, MatchableProxy> | undefined,
): ResolvedHop[] {
  const all = Object.values(records ?? {}).filter(isUsableNode)
  const usedNames = new Set<string>()

  return presetNodes.map((node) => {
    const exact = records?.[node.name]
    if (exact && isUsableNode(exact) && !usedNames.has(exact.name)) {
      usedNames.add(exact.name)
      return {
        presetName: node.name,
        presetKeyword: node.keyword,
        resolvedName: exact.name,
        matchType: 'exact' as const,
        delay: latestDelay(exact),
      }
    }

    if (node.keyword) {
      const candidates = all.filter(
        (p) => !usedNames.has(p.name) && matchByKeyword(p, node.keyword!),
      )
      const best = pickByLowestDelay(candidates)
      if (best) {
        usedNames.add(best.name)
        return {
          presetName: node.name,
          presetKeyword: node.keyword,
          resolvedName: best.name,
          matchType: 'keyword' as const,
          delay: latestDelay(best),
        }
      }
    }

    return {
      presetName: node.name,
      presetKeyword: node.keyword,
      resolvedName: null,
      matchType: 'miss' as const,
    }
  })
}
