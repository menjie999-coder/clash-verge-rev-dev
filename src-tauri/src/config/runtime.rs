use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::collections::{HashMap, HashSet};

use crate::enhance::field::use_keys;

const PATCH_CONFIG_INNER: [&str; 5] = ["allow-lan", "ipv6", "log-level", "unified-delay", "tunnels"];

#[derive(Default, Clone)]
pub struct IRuntime {
    pub config: Option<Mapping>,
    // 记录在订阅中（包括merge和script生成的）出现过的keys
    // 这些keys不一定都生效
    pub exists_keys: HashSet<String>,
    // TODO 或许可以用 FixMap 来存储以提升效率
    pub chain_logs: HashMap<String, Vec<(String, String)>>,
}

impl IRuntime {
    #[inline]
    pub fn new() -> Self {
        Self::default()
    }

    // 这里只更改 allow-lan | ipv6 | log-level | tun | tunnels
    #[inline]
    pub fn patch_config(&mut self, patch: &Mapping) {
        let config = if let Some(config) = self.config.as_mut() {
            config
        } else {
            return;
        };

        for key in PATCH_CONFIG_INNER.iter() {
            if let Some(value) = patch.get(key) {
                config.insert((*key).into(), value.clone());
            }
        }

        let patch_tun = patch.get("tun");
        if let Some(patch_tun_value) = patch_tun {
            let mut tun = config
                .get("tun")
                .and_then(|val| val.as_mapping())
                .cloned()
                .unwrap_or_else(Mapping::new);

            if let Some(patch_tun_mapping) = patch_tun_value.as_mapping() {
                for key in use_keys(patch_tun_mapping) {
                    if let Some(value) = patch_tun_mapping.get(key.as_str()) {
                        tun.insert(Value::from(key.as_str()), value.clone());
                    }
                }
            }

            config.insert("tun".into(), Value::from(tun));
        }
    }

    /// 更新链式代理配置
    ///
    /// 该函数更新 `proxies` 和 `proxy-groups` 配置，并处理链式代理的修改或(传入 None )删除。
    ///
    /// 配置示例：
    ///
    /// ```json
    /// {
    ///     "proxies": [
    ///         {
    ///             "name": "入口节点",
    ///             "type": "xxx",
    ///             "server": "xxx",
    ///             "port": "xxx",
    ///             "ports": "xxx",
    ///             "password": "xxx",
    ///             "skip-cert-verify": "xxx"
    ///         },
    ///         {
    ///             "name": "hop_node_1_xxxx",
    ///             "type": "xxx",
    ///             "server": "xxx",
    ///             "port": "xxx",
    ///             "ports": "xxx",
    ///             "password": "xxx",
    ///             "skip-cert-verify": "xxx",
    ///             "dialer-proxy": "入口节点"
    ///         },
    ///         {
    ///             "name": "出口节点",
    ///             "type": "xxx",
    ///             "server": "xxx",
    ///             "port": "xxx",
    ///             "ports": "xxx",
    ///             "password": "xxx",
    ///             "skip-cert-verify": "xxx",
    ///             "dialer-proxy": "hop_node_1_xxxx"
    ///         }
    ///     ],
    ///     "proxy-groups": [
    ///         {
    ///             "name": "proxy_chain",
    ///             "type": "select",
    ///             "proxies": ["出口节点"]
    ///         }
    ///     ]
    /// }
    /// ```
    #[inline]
    pub fn update_proxy_chain_config(&mut self, proxy_chain_config: Option<Value>) {
        let config = if let Some(config) = self.config.as_mut() {
            config
        } else {
            return;
        };

        if let Some(Value::Sequence(proxies)) = config.get_mut("proxies") {
            proxies.iter_mut().for_each(|proxy| {
                if let Some(proxy) = proxy.as_mapping_mut()
                    && proxy.get("dialer-proxy").is_some()
                {
                    proxy.remove("dialer-proxy");
                }
            });
        }

        if let Some(Value::Sequence(dialer_proxies)) = proxy_chain_config
            && let Some(Value::Sequence(proxies)) = config.get_mut("proxies")
        {
            for (i, dialer_proxy) in dialer_proxies.iter().enumerate() {
                if let Some(Value::Mapping(proxy)) =
                    proxies.iter_mut().find(|proxy| proxy.get("name") == Some(dialer_proxy))
                    && i != 0
                    && let Some(dialer_proxy) = dialer_proxies.get(i - 1)
                {
                    proxy.insert("dialer-proxy".into(), dialer_proxy.to_owned());
                }
            }
        }
    }

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
            .map(std::string::String::from);

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
}

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

    fn names_of_group(cfg: &Mapping, group: &str) -> Vec<std::string::String> {
        if let Some(Value::Sequence(groups)) = cfg.get("proxy-groups") {
            for g in groups {
                if g.get("name").and_then(|v| v.as_str()) == Some(group) {
                    if let Some(Value::Sequence(ps)) = g.get("proxies") {
                        return ps
                            .iter()
                            .filter_map(|p| p.as_str().map(std::string::String::from))
                            .collect();
                    }
                }
            }
        }
        vec![]
    }

    fn dialer_of(cfg: &Mapping, node: &str) -> Option<std::string::String> {
        if let Some(Value::Sequence(proxies)) = cfg.get("proxies") {
            for p in proxies {
                if p.get("name").and_then(|v| v.as_str()) == Some(node) {
                    return p
                        .get("dialer-proxy")
                        .and_then(|v| v.as_str())
                        .map(std::string::String::from);
                }
            }
        }
        None
    }

    fn run(payload: Option<Value>) -> Mapping {
        let mut runtime = IRuntime {
            config: Some(base_config()),
            ..Default::default()
        };
        runtime.update_smart_chain_config(payload);
        runtime.config.unwrap()
    }

    #[test]
    fn injects_groups_and_dialer_proxy_by_group() {
        let cfg = run(Some(payload(
            "GLOBAL",
            &[("__CHAIN_HOP_0", &["HK-1"]), ("__CHAIN_HOP_1", &["JP-1"])],
        )));
        assert_eq!(dialer_of(&cfg, "HK-1"), None);
        assert_eq!(
            dialer_of(&cfg, "JP-1"),
            Some("__CHAIN_HOP_0".to_string())
        );
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
        let mut runtime = IRuntime {
            config: Some(base_config()),
            ..Default::default()
        };
        runtime.update_smart_chain_config(Some(payload(
            "PROXY",
            &[("__CHAIN_HOP_0", &["HK-1"]), ("__CHAIN_HOP_1", &["JP-1"])],
        )));
        runtime.update_smart_chain_config(None);
        let cfg = runtime.config.unwrap();
        assert_eq!(dialer_of(&cfg, "JP-1"), None);
        assert!(names_of_group(&cfg, "__CHAIN_HOP_0").is_empty());
        assert!(!names_of_group(&cfg, "PROXY").contains(&"__CHAIN_HOP_1".to_string()));
    }
}
