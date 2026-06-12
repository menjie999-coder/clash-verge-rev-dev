# 智能链式代理（Smart Chain Proxy）设计

- 日期：2026-06-12
- 状态：已确认设计，待进入实现计划
- 目标仓库：clash-verge-rev（Tauri + React + Rust/mihomo 内核）

## 1. 背景与痛点

现有链式代理功能已内置在 app 中，工作方式：

1. 用户按顺序选节点 → 前端把节点名数组传给 Rust。
2. Rust 在运行时配置里给每个节点注入 `dialer-proxy: 上一跳节点名`，最后一跳作为出口，选中到目标策略组。
3. 预设（`verge.proxy_chain_presets`）保存 `{节点名, 关键词(地区), 目标组}`，应用时按"精确名 → 关键词+最低延迟 → miss"逐跳解析。
4. 前端有 30s 心跳健康检查：链里某跳连续 2 次超时 → 标红 → 弹 Alert，但**只能手动点"恢复连接"，且恢复时重选同一个（可能已死的）节点**。

**根因痛点**：预设一旦应用就被钉死成具体节点名；预设里的"关键词+最低延迟"解析只在应用那一刻跑一次，之后不再重算。当入口/某跳的节点超时，整条链就断了，没有自动切换到同地区健康备选节点的能力。

## 2. 已确认的设计决策

| 决策点 | 选择 |
|---|---|
| 范围方向 | 增强现有内置功能（不做独立工具） |
| 故障转移行为 | 自动切到同地区健康节点（用户无感） |
| "一跳"的本质 | 地区/意图为准，运行时动态解析 |
| 自愈机制放哪 | **Route C 为核心**（mihomo 原生 url-test 组）**+ Route A 前端做构建器/预览** |

## 3. 核心机制：mihomo 原生 url-test 组实现每跳故障转移

不再把 `dialer-proxy` 指向固定节点，而是为每个地区跳生成一个 `url-test` 策略组，把 dialer-proxy 指向"上一跳的组"。

链路 `香港 → 日本 → 美国（出口）` 生成：

```yaml
proxy-groups:
  - { name: __CHAIN_HOP_0__, type: url-test, proxies: [所有香港节点], url: http://www.gstatic.com/generate_204, interval: 60, tolerance: 50 }
  - { name: __CHAIN_HOP_1__, type: url-test, proxies: [所有日本节点], url: http://www.gstatic.com/generate_204, interval: 60, tolerance: 50 }
  - { name: __CHAIN_HOP_2__, type: url-test, proxies: [所有美国节点], url: http://www.gstatic.com/generate_204, interval: 60, tolerance: 50 }
proxies:
  # 日本每个节点注入 dialer-proxy 指向香港组
  - { name: JP-1, ..., dialer-proxy: __CHAIN_HOP_0__ }
  # 美国每个节点注入 dialer-proxy 指向日本组
  - { name: US-1, ..., dialer-proxy: __CHAIN_HOP_1__ }
```

出口选 `__CHAIN_HOP_2__`。mihomo 的 url-test 在**每一跳**自动挑延迟最低的健康节点、自动剔除超时节点——**关窗、最小化都照常切换**。前端的 30s 心跳自愈降级成纯只读监控。

### ⚠️ 必须先验证的假设（Phase 0 Spike）

mihomo 的 `dialer-proxy` 取值指向"策略组名"是否被支持、多级组链是否生效，需要用最小配置跑一遍内核确认。

- **若成立**：走 Route C。
- **若不成立**：自动回退到 Route A（前端按地区重解析 + 重连），对用户透明，只是丢掉"关窗也能切"这一条。

兜底：现有 `apply_generate_config` 已有配置校验 + 回滚，坏配置不会让内核崩。

## 4. 数据模型

一跳从"固定节点名"变成"意图"：

```ts
type RegionKey = 'HK' | 'JP' | 'US' | 'SG' | /* ...REGION_PATTERNS 现有键 */

type ChainHop =
  | { kind: 'region'; value: RegionKey }   // 按地区解析
  | { kind: 'filter'; value: string }      // 关键词/正则解析
  | { kind: 'pinned'; value: string }      // 固定节点名（高级逃生口）
```

- 预设 `IProxyChainPreset` 增加 `hops: ChainHop[]`，保留旧 `nodes` 字段做兼容读取。
- **迁移**：旧预设节点有 keyword → `region` 跳；无 keyword → `pinned` 跳。一次性无损升级，老用户预设照常能用。

## 5. 组件与代码落点

| 模块 | 职责 | 改动 |
|---|---|---|
| `chain-resolver.ts`（由 `src/utils/chain-preset-match.ts` 扩展） | 纯函数：地区→候选节点集、健康过滤、排序、跨跳去重。可单测 | 扩展 |
| `useSmartChain` hook（新增） | 拥有 hops 状态、生成组配置、调用注入、只读健康监控 | 新增 |
| `src/components/proxy/proxy-chain.tsx`（现 ~935 行，逻辑+展示混在一起） | 抽离编排逻辑到 hook，组件回归纯展示 | 重构瘦身 |
| 智能链构建器 UI（新增） | 按地区下拉添加跳（国旗 + 实时健康节点数 + 最优延迟预览）、拖拽排序、常用模板一键套用 | 新增 |
| `update_proxy_chain_config`（`src-tauri/src/config/runtime.rs`） | 从"按名注入"扩展为"生成 url-test 组 + 按组注入 dialer-proxy + 清理旧合成组" | 扩展 |
| 出口/目标组接线 | 合成出口组需作为成员加入目标组（或走专用 `__PROXY_CHAIN__` select），规则模式下尤其要处理 | 新增细节 |

### 设计约束

- 同一地区不可在一条链里出现两次（因为 dialer-proxy 注入在物理节点上，节点只能有一个 dialer-proxy 值）。构建器层面禁止重复地区。
- 合成组名用固定前缀 `__CHAIN_HOP_`，便于注入前清理上一轮的合成组。

## 6. 傻瓜式配置体验

- 主路径：下拉选地区拖成一条链，每跳实时显示"当前落到哪个节点 + 延迟"，无需懂 dialer-proxy。
- 常用模板：如"香港中转 → 美国落地"一键生成。
- 固定具体节点降级为"高级/锁定"选项（`pinned`）。
- 保存预设存的是意图（hops），不是节点名——换了机场订阅、节点名变了，预设照样能用。

## 7. 错误处理 & 防抖

- 某地区**一个健康节点都没有** → 不拆链、保留上次可用配置 + 醒目提示该地区不可用。
- url-test 自带 tolerance/interval，天然防抖；前端不再主动切换，无抖动风险。
- 注入后配置校验失败 → Rust 侧回滚，提示用户。

## 8. 测试

- `chain-resolver` 单测：地区/关键词/正则匹配、跨跳去重、最低延迟选择、无候选、确定性 tie-break。
- 配置生成单测：给定 hops + 节点表 → 期望的 proxy-groups + dialer-proxy 注入结果。
- Rust 注入单测：合成组生成、旧组清理、目标组接线。

## 9. 分期实施

- **Phase 0**：mihomo `dialer-proxy` → 组 的可行性 spike（决定走 C 还是回退 A）。
- **Phase 1**：resolver + Rust 注入扩展 + 数据模型/迁移（核心机制跑通）。
- **Phase 2**：智能链构建器 UI + 实时预览 + 模板。
- **Phase 3**：只读健康监控收尾、旧预设迁移、文档。

## 10. 兼容性

- 旧 `proxy_chain_presets` 预设无损迁移为 hops。
- 现有"手动选具体节点连链"流程保留为 `pinned` 高级模式。
- 退出链式代理 / 清除配置的现有路径（`updateProxyChainConfigInRuntime(null)`）继续清理所有 dialer-proxy 与合成组。
