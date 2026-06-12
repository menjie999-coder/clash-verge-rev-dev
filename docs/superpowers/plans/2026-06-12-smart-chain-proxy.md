# Smart Chain Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chain proxies self-heal by defining each hop as a region/intent that resolves to a live mihomo `url-test` group, so a timed-out hop node fails over natively without breaking the chain.

**Architecture:** Each chain hop becomes a generated `url-test` proxy-group containing all nodes of that region/filter; `dialer-proxy` on each node points to the *previous hop's group name*, so mihomo's url-test picks the lowest-latency healthy node per hop and fails over automatically (works even when the app window is hidden). The frontend resolves region → candidate node names (it owns the proxy records) and a builder UI lets users assemble the chain by region with a live preview. Resolution lives in TS; group/dialer-proxy injection lives in Rust.

**Tech Stack:** Rust (Tauri, serde_yaml_ng), React 19 + TypeScript + MUI, mihomo (clash-meta) core, vitest (added in this plan).

**Spec:** `docs/superpowers/specs/2026-06-12-smart-chain-proxy-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/utils/chain-preset-match.ts` | Existing region patterns + preset resolution. Stays; `REGION_PATTERNS`, `extractKeyword`, `isUsableNode`, `latestDelay` get exported for reuse | Modify |
| `src/utils/chain-resolver.ts` | NEW pure module: resolve `ChainHop[]` → per-hop healthy candidate groups | Create |
| `src/utils/chain-resolver.test.ts` | Vitest unit tests for the resolver | Create |
| `src/utils/chain-config-builder.ts` | NEW pure module: build the Rust injection payload (group specs + target group) from resolved hops | Create |
| `src/utils/chain-config-builder.test.ts` | Vitest unit tests for the builder | Create |
| `src/types/global.d.ts` | Add `ChainHop`, extend `IProxyChainPreset` with `hops?` | Modify (`:990-1002`) |
| `src/services/proxy-chain-storage.ts` | Persist `hops` + target group in chain state | Modify |
| `src/services/cmds.ts` | Add `updateSmartChainConfigInRuntime` wrapper | Modify (`:111-115`) |
| `src/hooks/use-smart-chain.ts` | NEW hook: owns hops state, resolution, injection call, read-only monitoring | Create |
| `src/components/proxy/smart-chain-builder.tsx` | NEW builder UI: add/reorder region hops, live preview | Create |
| `src/components/proxy/proxy-chain.tsx` | Wire in builder; extract orchestration to hook | Modify |
| `src-tauri/src/config/runtime.rs` | Add `update_smart_chain_config` + cleanup; add `#[test]` | Modify (`:108-140`) |
| `src-tauri/src/cmd/runtime.rs` | Add `update_smart_chain_config_in_runtime` command | Modify (`:94-110`) |
| `src-tauri/src/lib.rs` | Register new command | Modify (`:171`) |
| `vitest.config.ts` | NEW vitest config | Create |
| `package.json` | Add vitest devDep + `test` script | Modify |
| `src/locales/{zh,en}/proxies.json` | New i18n keys for builder/monitoring | Modify |

**Backward compatibility:** the old `update_proxy_chain_config` / `update_proxy_chain_config_in_runtime` path stays untouched so existing pinned chains keep working until a chain is rebuilt as a smart chain.

---

## Phase 0 — Validation Spike (GATE)

This phase decides whether Route C (native url-test groups) is viable. **Do not start Phase 1 until this passes.** If it fails, stop and report — the fallback is Route A (frontend re-resolution), which changes Phase 1's mechanism.

### Task 0.1: Confirm mihomo `dialer-proxy` accepts a group name and multi-level chaining works

**Files:**
- Create (throwaway): `spike/smart-chain-test.yaml`

- [ ] **Step 1: Write a minimal config with two url-test region groups and a node dialing through a group**

Create `spike/smart-chain-test.yaml`. Replace the two `HK-*`/`JP-*` proxy entries with two real working nodes you have (one that will be the relay/entry, one that will be the landing). The landing node's `dialer-proxy` references the **group name** `__CHAIN_HOP_0__`, not a node name:

```yaml
mixed-port: 7890
mode: global
log-level: info
proxies:
  - { name: HK-1, type: <your-entry-node-type>, server: ..., port: ..., ... }
  - { name: JP-1, type: <your-landing-node-type>, server: ..., port: ..., dialer-proxy: __CHAIN_HOP_0__ }
proxy-groups:
  - { name: __CHAIN_HOP_0__, type: url-test, proxies: [HK-1], url: 'http://www.gstatic.com/generate_204', interval: 60 }
  - { name: __CHAIN_HOP_1__, type: url-test, proxies: [JP-1], url: 'http://www.gstatic.com/generate_204', interval: 60 }
  - { name: PROXY, type: select, proxies: [__CHAIN_HOP_1__] }
rules:
  - MATCH,PROXY
```

- [ ] **Step 2: Run the bundled mihomo core against this config**

Find the core binary used by the app (under `src-tauri` sidecar dir, named `verge-mihomo` / `verge-mihomo-alpha`). Run it directly:

Run (PowerShell): `& "<path>\verge-mihomo.exe" -f spike\smart-chain-test.yaml -d spike`
Expected: core starts with no config-validation error, and logs show `__CHAIN_HOP_0__`/`__CHAIN_HOP_1__` groups created.

- [ ] **Step 3: Verify the chain actually tunnels**

With the core running, send a request through it and confirm the egress IP is the landing node's region (so traffic went HK → JP):

Run (PowerShell): `curl.exe -x http://127.0.0.1:7890 https://api.ip.sb/geoip`
Expected: JSON shows the **landing** node's country, proving `dialer-proxy: __CHAIN_HOP_0__` routed JP through the HK group.

- [ ] **Step 4: Record the verdict**

Append a short result block (PASS/FAIL + evidence) to the spec file under a new `## 11. Phase 0 Spike Result` section, and commit it.

```bash
git add docs/superpowers/specs/2026-06-12-smart-chain-proxy-design.md
git commit -m "spike: validate mihomo dialer-proxy -> url-test group chaining"
```

> **GATE:** PASS → continue to Phase 1. FAIL → stop, report to user; Phase 1 mechanism switches to Route A (resolve concrete names in TS, keep sending plain name arrays to the existing `update_proxy_chain_config`, and re-resolve+reconnect from the frontend monitor loop).

---

## Phase 1 — Core Mechanism

### Task 1.1: Add the vitest harness

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Add vitest as a dev dependency**

Run: `pnpm add -D vitest@^3`
Expected: `vitest` appears in `package.json` devDependencies.

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
```

- [ ] **Step 3: Add a `test` script to `package.json`**

In the `scripts` block add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Add a smoke test and run it**

Create `src/utils/__smoke__.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

describe('vitest harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Run: `pnpm test`
Expected: 1 passing test.

- [ ] **Step 5: Delete the smoke test and commit**

```bash
rm src/utils/__smoke__.test.ts
git add package.json vitest.config.ts pnpm-lock.yaml
git commit -m "test: add vitest harness"
```

### Task 1.2: Export reusable internals from `chain-preset-match.ts`

**Files:**
- Modify: `src/utils/chain-preset-match.ts`

- [ ] **Step 1: Export the helpers the resolver needs**

Change these existing declarations to be exported (add `export`):
- `REGION_PATTERNS` (line 1): `export const REGION_PATTERNS: ...`
- `isUsableNode` (line 72): `export const isUsableNode = ...`
- `latestDelay` (line 65): `export const latestDelay = ...`

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/chain-preset-match.ts
git commit -m "refactor: export chain-preset-match internals for reuse"
```

### Task 1.3: Add `ChainHop` type and extend `IProxyChainPreset`

**Files:**
- Modify: `src/types/global.d.ts:990-1002`

- [ ] **Step 1: Add the hop type and extend the preset interface**

Replace the `IProxyChainPresetNode` / `IProxyChainPreset` block (`:990-1002`) with:

```ts
interface IProxyChainPresetNode {
  name: string
  keyword?: string
}

type IChainHopKind = 'region' | 'filter' | 'pinned'

interface IChainHop {
  kind: IChainHopKind
  value: string
}

interface IProxyChainPreset {
  id: string
  name: string
  nodes: IProxyChainPresetNode[]
  hops?: IChainHop[]
  target_group?: string
  created_at: number
  last_used_at?: number
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no new errors (the new field is optional).

- [ ] **Step 3: Commit**

```bash
git add src/types/global.d.ts
git commit -m "feat: add ChainHop type and hops field on chain preset"
```

### Task 1.4: Write the chain resolver (TDD)

**Files:**
- Create: `src/utils/chain-resolver.ts`
- Test: `src/utils/chain-resolver.test.ts`

The resolver turns `IChainHop[]` + the proxies records map into one resolved group per hop. Healthy = latest delay defined, `> 0`, `< timeout`. Candidates sorted by delay ascending, tie-break by name. Cross-hop "first claim": a node assigned to an earlier hop is excluded from later hops so each node lands in exactly one group (guarantees one `dialer-proxy` value per node).

- [ ] **Step 1: Write the failing tests**

```ts
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
// remap keys to node names so records is keyed by name like the app's records map
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
    expect(groups[0].candidates).toEqual(['HK 香港 01', 'HK 香港 02']) // dead (0ms) excluded, sorted
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
    // 'HK 香港 01' matches both; it is claimed by hop 0, so hop 1 must not contain it
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/chain-resolver.test.ts`
Expected: FAIL with "Cannot find module './chain-resolver'".

- [ ] **Step 3: Implement `chain-resolver.ts`**

```ts
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
  // filter: case-insensitive substring
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
```

> Note: `MatchableProxy` is already exported from `chain-preset-match.ts`. Pinned hops skip the health filter so a user-locked node is always included even when its last probe timed out.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/chain-resolver.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/chain-resolver.ts src/utils/chain-resolver.test.ts
git commit -m "feat: add chain resolver for region/filter/pinned hops"
```

### Task 1.5: Write the injection-payload builder (TDD)

**Files:**
- Create: `src/utils/chain-config-builder.ts`
- Test: `src/utils/chain-config-builder.test.ts`

Builds the payload the Rust command consumes. Shape:

```ts
interface SmartChainPayload {
  target_group: string
  hops: { name: string; type: 'url-test'; proxies: string[]; url: string; interval: number; tolerance: number }[]
}
```

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/chain-config-builder.test.ts`
Expected: FAIL with "Cannot find module './chain-config-builder'".

- [ ] **Step 3: Implement `chain-config-builder.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/chain-config-builder.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/chain-config-builder.ts src/utils/chain-config-builder.test.ts
git commit -m "feat: add smart chain injection payload builder"
```

### Task 1.6: Rust — inject url-test groups + dialer-proxy by group (TDD)

**Files:**
- Modify: `src-tauri/src/config/runtime.rs:108-140`

Add `update_smart_chain_config(&mut self, payload: Option<Value>)`. Behavior:
1. **Cleanup** (always): remove `dialer-proxy` from every proxy; remove every proxy-group whose name starts with `__CHAIN_HOP_`; remove any `__CHAIN_HOP_*` entry from every remaining group's `proxies` list.
2. If `payload` is `Some` mapping with `hops` + `target_group`:
   - Append each hop spec to `proxy-groups` (create the sequence if absent).
   - For `i > 0`, for each node name in `hops[i].proxies`, find that proxy in `proxies` and set `dialer-proxy = hops[i-1].name`.
   - Append the last hop's group name to the target group's `proxies` list (so it is selectable), unless `target_group` is `GLOBAL`.

- [ ] **Step 1: Write the failing test**

Add at the bottom of `src-tauri/src/config/runtime.rs`:

```rust
#[cfg(test)]
mod smart_chain_tests {
    use super::*;
    use serde_yaml_ng::{Mapping, Value};

    fn proxy(name: &str) -> Value {
        let mut m = Mapping::new();
        m.insert("name".into(), name.into());
        m.insert("type".into(), "ss".into());
        Value::Mapping(m)
    }

    fn select_group(name: &str, members: &[&str]) -> Value {
        let mut m = Mapping::new();
        m.insert("name".into(), name.into());
        m.insert("type".into(), "select".into());
        m.insert(
            "proxies".into(),
            Value::Sequence(members.iter().map(|s| (*s).into()).collect()),
        );
        Value::Mapping(m)
    }

    fn base_config() -> Mapping {
        let mut cfg = Mapping::new();
        cfg.insert(
            "proxies".into(),
            Value::Sequence(vec![proxy("HK-1"), proxy("JP-1"), proxy("US-1")]),
        );
        cfg.insert(
            "proxy-groups".into(),
            Value::Sequence(vec![select_group("PROXY", &["HK-1", "JP-1", "US-1"])]),
        );
        cfg
    }

    fn payload(target: &str, hops: &[(&str, &[&str])]) -> Value {
        let mut p = Mapping::new();
        p.insert("target_group".into(), target.into());
        let hop_seq: Vec<Value> = hops
            .iter()
            .map(|(name, members)| {
                let mut h = Mapping::new();
                h.insert("name".into(), (*name).into());
                h.insert("type".into(), "url-test".into());
                h.insert(
                    "proxies".into(),
                    Value::Sequence(members.iter().map(|s| (*s).into()).collect()),
                );
                Value::Mapping(h)
            })
            .collect();
        p.insert("hops".into(), Value::Sequence(hop_seq));
        Value::Mapping(p)
    }

    fn names_of_group<'a>(cfg: &'a Mapping, group: &str) -> Vec<String> {
        if let Some(Value::Sequence(groups)) = cfg.get("proxy-groups") {
            for g in groups {
                if g.get("name").and_then(|v| v.as_str()) == Some(group) {
                    if let Some(Value::Sequence(ps)) = g.get("proxies") {
                        return ps.iter().filter_map(|p| p.as_str().map(String::from)).collect();
                    }
                }
            }
        }
        vec![]
    }

    fn dialer_of<'a>(cfg: &'a Mapping, node: &str) -> Option<String> {
        if let Some(Value::Sequence(proxies)) = cfg.get("proxies") {
            for p in proxies {
                if p.get("name").and_then(|v| v.as_str()) == Some(node) {
                    return p.get("dialer-proxy").and_then(|v| v.as_str()).map(String::from);
                }
            }
        }
        None
    }

    fn run(payload: Option<Value>) -> Mapping {
        let mut runtime = IRuntime { config: Some(base_config()), exists_keys: vec![], chain_logs: Default::default() };
        runtime.update_smart_chain_config(payload);
        runtime.config.unwrap()
    }

    #[test]
    fn injects_groups_and_dialer_proxy_by_group() {
        let cfg = run(Some(payload(
            "GLOBAL",
            &[("__CHAIN_HOP_0", &["HK-1"]), ("__CHAIN_HOP_1", &["JP-1"])],
        )));
        // entry hop node has no dialer-proxy
        assert_eq!(dialer_of(&cfg, "HK-1"), None);
        // second hop node dials through the previous hop's GROUP name
        assert_eq!(dialer_of(&cfg, "JP-1"), Some("__CHAIN_HOP_0".to_string()));
        // both hop groups were created
        assert!(!names_of_group(&cfg, "__CHAIN_HOP_0").is_empty());
        assert!(!names_of_group(&cfg, "__CHAIN_HOP_1").is_empty());
    }

    #[test]
    fn rule_mode_appends_exit_group_to_target_group() {
        let cfg = run(Some(payload(
            "PROXY",
            &[("__CHAIN_HOP_0", &["HK-1"]), ("__CHAIN_HOP_1", &["JP-1"])],
        )));
        assert!(names_of_group(&cfg, "PROXY").contains(&"__CHAIN_HOP_1".to_string()));
    }

    #[test]
    fn cleanup_removes_groups_and_dialer_proxy_and_membership() {
        // build a chain, then tear it down with None
        let mut runtime = IRuntime { config: Some(base_config()), exists_keys: vec![], chain_logs: Default::default() };
        runtime.update_smart_chain_config(Some(payload(
            "PROXY",
            &[("__CHAIN_HOP_0", &["HK-1"]), ("__CHAIN_HOP_1", &["JP-1"])],
        )));
        runtime.update_smart_chain_config(None);
        let cfg = runtime.config.unwrap();
        assert_eq!(dialer_of(&cfg, "JP-1"), None);
        assert!(names_of_group(&cfg, "__CHAIN_HOP_0").is_empty()); // group gone => empty lookup
        assert!(!names_of_group(&cfg, "PROXY").contains(&"__CHAIN_HOP_1".to_string()));
    }
}
```

> Before running, confirm the real field names of the `IRuntime` struct (the test constructs it directly). Open `src-tauri/src/config/runtime.rs` top and match the struct literal fields (`config`, `exists_keys`, `chain_logs`) to the actual definition; adjust the helper `run`/test constructors if they differ.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test smart_chain_tests`
Expected: FAIL — `update_smart_chain_config` does not exist.

- [ ] **Step 3: Implement `update_smart_chain_config`**

Add this method inside the `impl IRuntime` block, right after `update_proxy_chain_config` (around `:139`):

```rust
    /// 更新智能链式代理配置：为每个地区跳生成 url-test 组，并把 dialer-proxy 指向上一跳的组名。
    /// 传入 None 时清理所有合成组、dialer-proxy 及目标组中的合成成员。
    pub fn update_smart_chain_config(&mut self, payload: Option<Value>) {
        const PREFIX: &str = "__CHAIN_HOP_";

        let config = match self.config.as_mut() {
            Some(c) => c,
            None => return,
        };

        // 1. 清理：去掉所有节点的 dialer-proxy
        if let Some(Value::Sequence(proxies)) = config.get_mut("proxies") {
            for proxy in proxies.iter_mut() {
                if let Some(map) = proxy.as_mapping_mut() {
                    map.remove("dialer-proxy");
                }
            }
        }
        // 清理：删除合成组，并从其余组的 proxies 列表里移除对合成组的引用
        if let Some(Value::Sequence(groups)) = config.get_mut("proxy-groups") {
            groups.retain(|g| {
                g.get("name")
                    .and_then(|v| v.as_str())
                    .map(|n| !n.starts_with(PREFIX))
                    .unwrap_or(true)
            });
            for g in groups.iter_mut() {
                if let Some(Value::Sequence(members)) =
                    g.as_mapping_mut().and_then(|m| m.get_mut("proxies"))
                {
                    members.retain(|m| {
                        m.as_str().map(|s| !s.starts_with(PREFIX)).unwrap_or(true)
                    });
                }
            }
        }

        // 2. 注入
        let Some(Value::Mapping(payload)) = payload else {
            return;
        };
        let Some(Value::Sequence(hops)) = payload.get("hops") else {
            return;
        };
        let hops = hops.clone();
        let target_group = payload
            .get("target_group")
            .and_then(|v| v.as_str())
            .map(String::from);

        // 2a. 追加合成组
        if !config.contains_key("proxy-groups") {
            config.insert("proxy-groups".into(), Value::Sequence(vec![]));
        }
        if let Some(Value::Sequence(groups)) = config.get_mut("proxy-groups") {
            for hop in &hops {
                groups.push(hop.clone());
            }
        }

        // 2b. 给每个 i>0 跳的节点注入 dialer-proxy = 上一跳的组名
        if let Some(Value::Sequence(proxies)) = config.get_mut("proxies") {
            for (i, hop) in hops.iter().enumerate() {
                if i == 0 {
                    continue;
                }
                let prev_group = match hops[i - 1].get("name").and_then(|v| v.as_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if let Some(Value::Sequence(members)) = hop.get("proxies") {
                    for member in members {
                        if let Some(node_name) = member.as_str() {
                            if let Some(p) = proxies.iter_mut().find(|p| {
                                p.get("name").and_then(|v| v.as_str()) == Some(node_name)
                            }) {
                                if let Some(map) = p.as_mapping_mut() {
                                    map.insert(
                                        "dialer-proxy".into(),
                                        Value::String(prev_group.clone()),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        // 2c. 把出口组追加进目标组（GLOBAL 已含所有组，跳过）
        if let (Some(tg), Some(last)) = (
            target_group,
            hops.last().and_then(|h| h.get("name")).and_then(|v| v.as_str()),
        ) {
            if tg != "GLOBAL" {
                if let Some(Value::Sequence(groups)) = config.get_mut("proxy-groups") {
                    if let Some(g) = groups.iter_mut().find(|g| {
                        g.get("name").and_then(|v| v.as_str()) == Some(tg.as_str())
                    }) {
                        if let Some(Value::Sequence(members)) =
                            g.as_mapping_mut().and_then(|m| m.get_mut("proxies"))
                        {
                            let last_val = Value::String(last.to_string());
                            if !members.contains(&last_val) {
                                members.push(last_val);
                            }
                        }
                    }
                }
            }
        }
    }
```

> If the struct fields use `smartstring` `String` (the file imports `smartstring::alias::String` elsewhere) vs `std::String`, prefer `Value::String(...)` construction as shown — it targets `serde_yaml_ng::Value`, independent of the smartstring alias. Verify `Value` is already imported at the top of `runtime.rs` (it is, used by `update_proxy_chain_config`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test smart_chain_tests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config/runtime.rs
git commit -m "feat(core): inject url-test groups and dialer-proxy by group for smart chain"
```

### Task 1.7: Rust — expose the new command

**Files:**
- Modify: `src-tauri/src/cmd/runtime.rs:94-110`
- Modify: `src-tauri/src/lib.rs:171`

- [ ] **Step 1: Add the command**

After `update_proxy_chain_config_in_runtime` in `src-tauri/src/cmd/runtime.rs`, add:

```rust
/// 更新运行时智能链式代理配置
#[tauri::command]
pub async fn update_smart_chain_config_in_runtime(
    payload: Option<serde_yaml_ng::Value>,
) -> CmdResult<()> {
    {
        let runtime = Config::runtime().await;
        runtime.edit_draft(|d| d.update_smart_chain_config(payload));
    }
    match CoreManager::global().apply_generate_config().await {
        Ok(outcome) if outcome.is_valid() => Ok(()),
        Ok(outcome) => Err(format!("invalid smart chain config: {outcome:?}")),
        Err(e) => Err(e.to_string()),
    }
}
```

> Match the exact `Err(...)` arms of the existing `update_proxy_chain_config_in_runtime` (read `:102-110`) and mirror them so error handling is identical.

- [ ] **Step 2: Register the command in `lib.rs`**

After `cmd::update_proxy_chain_config_in_runtime,` (`:171`) add:

```rust
            cmd::update_smart_chain_config_in_runtime,
```

- [ ] **Step 3: Build the Rust side**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/cmd/runtime.rs src-tauri/src/lib.rs
git commit -m "feat(core): expose update_smart_chain_config_in_runtime command"
```

### Task 1.8: Frontend — command wrapper + storage

**Files:**
- Modify: `src/services/cmds.ts:111-115`
- Modify: `src/services/proxy-chain-storage.ts`

- [ ] **Step 1: Add the cmd wrapper**

After `updateProxyChainConfigInRuntime` in `src/services/cmds.ts`, add:

```ts
import type { SmartChainPayload } from '@/utils/chain-config-builder'

export async function updateSmartChainConfigInRuntime(
  payload: SmartChainPayload | null,
) {
  return invoke<void>('update_smart_chain_config_in_runtime', { payload })
}
```

(Place the `import type` with the other imports at the top of the file.)

- [ ] **Step 2: Extend persisted chain state with hops + target group**

In `src/services/proxy-chain-storage.ts`, extend `ProxyChainState`:

```ts
export interface ProxyChainState {
  enabled: boolean
  items: ProxyChainItem[]
  group: string | null
  exitNode: string | null
  hops?: IChainHop[]
}
```

And add `hops: Array.isArray(parsed.hops) ? parsed.hops : undefined` to the `readChainState` return object (mirroring the existing fields). Update `EMPTY` is not required since `hops` is optional.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/cmds.ts src/services/proxy-chain-storage.ts
git commit -m "feat: add smart chain cmd wrapper and persist hops"
```

---

## Phase 2 — Smart Chain Builder UI

### Task 2.1: The `useSmartChain` hook

**Files:**
- Create: `src/hooks/use-smart-chain.ts`

Owns: `hops` state, derived `resolvedGroups` (via `resolveChainGroups` over live `proxies.records`), `connect()`, `disconnect()`, and a read-only health snapshot. Connect = build payload → `updateSmartChainConfigInRuntime` → `selectNodeForGroup(targetGroup, lastGroupName)` → `closeAllConnections` → `refreshProxy`.

- [ ] **Step 1: Implement the hook**

```ts
import { useCallback, useMemo, useState } from 'react'
import {
  closeAllConnections,
  selectNodeForGroup,
} from 'tauri-plugin-mihomo-api'
import { useVerge } from '@/hooks/use-verge'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import { updateSmartChainConfigInRuntime } from '@/services/cmds'
import { patchChainState } from '@/services/proxy-chain-storage'
import {
  buildSmartChainPayload,
  DEFAULT_HEALTH_URL,
} from '@/utils/chain-config-builder'
import { resolveChainGroups } from '@/utils/chain-resolver'

export function useSmartChain(
  mode: string,
  selectedGroup: string | null | undefined,
) {
  const { verge } = useVerge()
  const { proxies } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const timeout = verge?.default_latency_timeout || 10000
  const [hops, setHops] = useState<IChainHop[]>([])
  const [busy, setBusy] = useState(false)

  const resolvedGroups = useMemo(
    () => resolveChainGroups(hops, proxies?.records, { timeout }),
    [hops, proxies?.records, timeout],
  )

  const targetGroup = mode === 'global' ? 'GLOBAL' : selectedGroup || null

  const connect = useCallback(async () => {
    if (hops.length < 2 || !targetGroup) return
    setBusy(true)
    try {
      const payload = buildSmartChainPayload(resolvedGroups, targetGroup, {
        healthUrl: DEFAULT_HEALTH_URL,
        interval: 60,
        tolerance: 50,
      })
      await updateSmartChainConfigInRuntime(payload)
      const exitGroup = payload.hops[payload.hops.length - 1].name
      await selectNodeForGroup(targetGroup, exitGroup)
      patchChainState({ group: targetGroup, exitNode: exitGroup, hops })
      await closeAllConnections()
      await refreshProxy()
    } finally {
      setBusy(false)
    }
  }, [hops, resolvedGroups, targetGroup, refreshProxy])

  const disconnect = useCallback(async () => {
    setBusy(true)
    try {
      await updateSmartChainConfigInRuntime(null)
      patchChainState({ group: null, exitNode: null, hops: [] })
      await closeAllConnections()
      await refreshProxy()
      setHops([])
    } finally {
      setBusy(false)
    }
  }, [refreshProxy])

  return { hops, setHops, resolvedGroups, connect, disconnect, busy, targetGroup }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-smart-chain.ts
git commit -m "feat: add useSmartChain hook"
```

### Task 2.2: The builder component

**Files:**
- Create: `src/components/proxy/smart-chain-builder.tsx`

A panel that: lists region options (from `REGION_PATTERNS`) with live healthy-count + best latency per region (computed by resolving a single-hop for that region against `proxies.records`); lets the user add a region as a hop (disabled if the region is already in the chain — enforces the no-duplicate-region rule); shows the ordered hop list with drag-to-reorder (reuse the existing `@dnd-kit` setup from `proxy-chain.tsx`); for each hop shows the live `bestNode` + `healthyCount` from `resolvedGroups`; and a Connect/Disconnect button wired to the hook.

- [ ] **Step 1: Implement the component**

Build `smart-chain-builder.tsx` using `useSmartChain`. Key elements:
- Region picker: `REGION_PATTERNS.map(p => p.key)` → a `Select`/menu; for each, compute `resolveChainGroups([{kind:'region', value:key}], records, {timeout})[0]` to show `healthyCount` and `bestNode` delay. Disable keys already present in `hops`.
- "Add hop" appends `{ kind: 'region', value: key }` to `hops` via `setHops`.
- Hop list: render `resolvedGroups`; each row shows hop index, region label (reuse flag emoji from `REGION_PATTERNS` if desired), `→ bestNode (delay)` or a red "无健康节点" chip when `healthyCount === 0`. Drag handles via `@dnd-kit` (mirror `SortableItem` in `proxy-chain.tsx:115-263`).
- Footer: Connect button `disabled={hops.length < 2 || !targetGroup || resolvedGroups.some(g => g.healthyCount === 0) || busy}`; Disconnect when connected.
- Templates: a small menu offering presets like `['HK','US']`, `['HK','JP','US']` that call `setHops(template.map(k => ({kind:'region', value:k})))`.

Use only i18n keys added in Task 3.2; no hard-coded user-facing strings.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/proxy/smart-chain-builder.tsx
git commit -m "feat: add smart chain builder UI"
```

### Task 2.3: Mount the builder in the proxy chain panel

**Files:**
- Modify: `src/components/proxy/proxy-chain.tsx`

- [ ] **Step 1: Add a mode toggle and render the builder**

In `proxy-chain.tsx`, add a tab/segmented toggle at the top: **"智能链 (Smart)"** vs **"手动 (Advanced)"**. Smart renders `<SmartChainBuilder mode={mode} selectedGroup={selectedGroup} />`; Advanced renders the existing manual UI unchanged. Default to Smart when `hops` exist or no manual chain is set; otherwise remember last choice in `localStorage` key `proxy-chain-ui-mode`.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Manual smoke test in the running app**

Run: `pnpm dev`
Then: switch to Smart tab → add HK + US → confirm each hop shows a live best node + latency → click Connect → confirm traffic works (open a site) → unplug: in a terminal, note the current exit node, then in the app re-test delays; confirm that when HK's current best node is made to fail (e.g. pick a region with one flaky node) mihomo auto-switches without the chain dropping.
Expected: chain connects; killing the current best node of a hop does not break connectivity (url-test reselects).

- [ ] **Step 4: Commit**

```bash
git add src/components/proxy/proxy-chain.tsx
git commit -m "feat: mount smart chain builder with smart/advanced toggle"
```

---

## Phase 3 — Monitoring, Migration, Docs

### Task 3.1: Read-only health snapshot in the builder

**Files:**
- Modify: `src/components/proxy/smart-chain-builder.tsx`
- Modify: `src/hooks/use-smart-chain.ts`

Since mihomo now does the failover, the frontend no longer switches nodes. Replace active healing with a read-only status: poll `proxies.records` (already refreshed elsewhere) every few seconds and show, per hop, the currently-selected node of its `__CHAIN_HOP_i` group (from `proxies.groups.find(g => g.name === groupName)?.now`) plus its delay. Surface a single chip: green when every hop has `healthyCount > 0` and a live `now`, amber when a hop's healthy pool shrank, red when any hop has zero healthy nodes.

- [ ] **Step 1: Implement the read-only snapshot**

Add to `useSmartChain` a derived `hopStatus` array mapping each `resolvedGroups[i]` to `{ now: proxies.groups?.find(g => g.name === g.groupName)?.now ?? null, healthyCount }`. Render per-hop `now` + overall chip in the builder.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-smart-chain.ts src/components/proxy/smart-chain-builder.tsx
git commit -m "feat: read-only per-hop health snapshot for smart chain"
```

### Task 3.2: i18n keys

**Files:**
- Modify: `src/locales/zh/proxies.json`
- Modify: `src/locales/en/proxies.json`

- [ ] **Step 1: Add keys**

Under the existing `page.chain` object add a `smart` block in both files. Mirror keys exactly across locales. Minimum set:

```json
"smart": {
  "tab": "智能链",
  "advancedTab": "手动",
  "addRegion": "添加地区",
  "regionHealthy": "{{count}} 个健康节点",
  "regionBest": "最优 {{delay}}ms",
  "noHealthyNode": "无健康节点",
  "currentNode": "当前：{{node}}",
  "templates": "常用模板",
  "connect": "连接",
  "disconnect": "断开",
  "duplicateRegion": "该地区已在链中",
  "status": { "healthy": "全链连通", "degraded": "部分地区可选节点减少", "down": "有地区无可用节点" }
}
```

(English file: same keys, translated values.)

- [ ] **Step 2: Validate i18n + types**

Run: `pnpm i18n:check && pnpm i18n:types && pnpm typecheck`
Expected: no missing/unused-key errors; generated key types updated.

- [ ] **Step 3: Commit**

```bash
git add src/locales/zh/proxies.json src/locales/en/proxies.json src/types/generated
git commit -m "i18n: add smart chain builder strings"
```

### Task 3.3: Migrate legacy presets to hops on read

**Files:**
- Modify: `src/components/proxy/proxy-chain-presets.tsx`

- [ ] **Step 1: Derive hops from legacy preset nodes when `hops` is absent**

Add a pure helper (top of file):

```ts
const presetToHops = (p: IProxyChainPreset): IChainHop[] =>
  p.hops ??
  p.nodes.map((n) =>
    n.keyword
      ? { kind: 'region' as const, value: n.keyword }
      : { kind: 'pinned' as const, value: n.name },
  )
```

Use `presetToHops(preset)` wherever a preset is applied so old presets feed the smart-chain path. When saving a new preset from the builder, write both `nodes` (for back-compat) and `hops`.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/proxy/proxy-chain-presets.tsx
git commit -m "feat: migrate legacy chain presets to hops"
```

### Task 3.4: Full verification pass

- [ ] **Step 1: Run the whole suite**

Run: `pnpm test && pnpm typecheck && pnpm lint && (cd src-tauri && cargo test && cargo check)`
Expected: all green.

- [ ] **Step 2: End-to-end manual check in the app**

Run: `pnpm dev`. Build a 3-hop smart chain (e.g. HK → JP → US), connect, browse, then force the current best node of the entry hop to time out (switch that region's node to a known-bad one or block it) and confirm connectivity holds because mihomo's url-test reselects. Confirm an old pinned preset still applies.
Expected: chain self-heals on hop failure; legacy preset still works.

- [ ] **Step 3: Final commit / branch ready for PR**

```bash
git add -A
git commit -m "chore: smart chain proxy feature complete"
```

---

## Self-Review Notes

- **Spec §3 (url-test group mechanism):** Task 1.6 (Rust injection), Task 1.5 (payload), Task 0.1 (spike gate).
- **Spec §3 fallback to Route A:** Phase 0 GATE note.
- **Spec §4 (data model + migration):** Task 1.3 (types), Task 3.3 (migration).
- **Spec §5 (resolver / hook / Rust / selection wiring):** Tasks 1.4, 2.1, 1.6 (incl. 2c target-group membership), 1.7.
- **Spec §6 (foolproof builder + templates):** Tasks 2.2, 2.3.
- **Spec §7 (no healthy node → keep last config + alert):** Task 1.5 throws before tearing down; Task 3.1 red status chip.
- **Spec §8 (tests):** Tasks 1.4, 1.5 (vitest), 1.6 (cargo test).
- **Spec §9 phases:** map 1:1 to Phase 0–3 here.
- **Type consistency:** `ResolvedHopGroup`, `SmartChainPayload`, `buildSmartChainPayload`, `resolveChainGroups`, `CHAIN_HOP_GROUP_PREFIX`/`__CHAIN_HOP_`, `update_smart_chain_config(_in_runtime)` used consistently across TS and Rust tasks.
