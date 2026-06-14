use super::CmdResult;
use crate::{cmd::StringifyErr as _, config::Config, core::CoreManager};
use anyhow::{Context as _, anyhow};
use clash_verge_logging::{Type, logging};
use serde_yaml_ng::Mapping;
use smartstring::alias::String;
use std::collections::{HashMap, HashSet};

/// 获取运行时配置
#[tauri::command]
pub async fn get_runtime_config() -> CmdResult<Option<Mapping>> {
    Ok(Config::runtime().await.latest_arc().config.clone())
}

/// 获取运行时YAML配置
#[tauri::command]
pub async fn get_runtime_yaml() -> CmdResult<String> {
    let runtime = Config::runtime().await;
    let runtime = runtime.latest_arc();

    let config = runtime.config.as_ref();
    config
        .ok_or_else(|| anyhow!("failed to parse config to yaml file"))
        .and_then(|config| {
            serde_yaml_ng::to_string(config)
                .context("failed to convert config to yaml")
                .map(|s| s.into())
        })
        .stringify_err()
}

/// 获取运行时存在的键
#[tauri::command]
pub async fn get_runtime_exists() -> CmdResult<HashSet<String>> {
    Ok(Config::runtime().await.latest_arc().exists_keys.clone())
}

/// 获取运行时日志
#[tauri::command]
pub async fn get_runtime_logs() -> CmdResult<HashMap<String, Vec<(String, String)>>> {
    Ok(Config::runtime().await.latest_arc().chain_logs.clone())
}

#[tauri::command]
pub async fn get_runtime_proxy_chain_config(proxy_chain_exit_node: String) -> CmdResult<String> {
    let runtime = Config::runtime().await;
    let runtime = runtime.latest_arc();

    let config = runtime
        .config
        .as_ref()
        .ok_or_else(|| anyhow!("failed to parse config to yaml file"))
        .stringify_err()?;

    if let Some(serde_yaml_ng::Value::Sequence(proxies)) = config.get("proxies") {
        let mut proxy_name = Some(Some(proxy_chain_exit_node.as_str()));
        let mut proxies_chain = Vec::new();

        while let Some(proxy) = proxies.iter().find(|proxy| {
            if let serde_yaml_ng::Value::Mapping(proxy_map) = proxy {
                proxy_map.get("name").map(|x| x.as_str()) == proxy_name && proxy_map.get("dialer-proxy").is_some()
            } else {
                false
            }
        }) {
            proxies_chain.push(proxy.to_owned());
            proxy_name = proxy.get("dialer-proxy").map(|x| x.as_str());
        }

        if let Some(entry_proxy) = proxies
            .iter()
            .find(|proxy| proxy.get("name").map(|x| x.as_str()) == proxy_name)
            && !proxies_chain.is_empty()
        {
            // 添加第一个节点
            proxies_chain.push(entry_proxy.to_owned());
        }

        proxies_chain.reverse();

        let mut config: HashMap<String, Vec<serde_yaml_ng::Value>> = HashMap::new();

        config.insert("proxies".into(), proxies_chain);

        serde_yaml_ng::to_string(&config)
            .context("YAML generation failed")
            .map(|s| s.into())
            .stringify_err()
    } else {
        Err("failed to get proxies or proxy-groups".into())
    }
}

/// 更新运行时链式代理配置
#[tauri::command]
pub async fn update_proxy_chain_config_in_runtime(proxy_chain_config: Option<serde_yaml_ng::Value>) -> CmdResult<()> {
    {
        let runtime = Config::runtime().await;
        runtime.edit_draft(|d| d.update_proxy_chain_config(proxy_chain_config));
        // 我们需要在 CoreManager 中验证并应用配置，这里不应该直接调用 runtime.apply()
    }
    match CoreManager::global().apply_generate_config().await {
        Ok(outcome) if outcome.is_valid() => Ok(()),
        Ok(outcome) => {
            logging!(
                warn,
                Type::Core,
                "Failed to apply runtime proxy chain config: {}",
                outcome
            );
            Err(format!("proxy chain config invalid: {}", outcome).into())
        }
        Err(err) => {
            logging!(
                error,
                Type::Core,
                "Failed to apply runtime proxy chain config: {}",
                err
            );
            Err(format!("failed to apply proxy chain config: {}", err).into())
        }
    }
}

/// 发送桌面通知
///
/// 用于链式代理异常等需要让用户在应用最小化/后台时也能实时感知的场景。
/// 标题与正文由前端传入（通常已完成本地化）。
#[tauri::command]
pub async fn send_desktop_notification(title: String, body: String) -> CmdResult<()> {
    crate::utils::notification::notify_text(&title, &body);
    Ok(())
}

/// 闪烁任务栏/请求用户注意
///
/// 系统通知可能被 Windows 通知设置或专注助手拦截，这里额外用任务栏高亮（橙色闪烁）提醒，
/// 不依赖通知中心；窗口最小化到任务栏时有效。
#[tauri::command]
pub async fn flash_window_attention() -> CmdResult<()> {
    use tauri::UserAttentionType;
    if let Some(window) = crate::utils::window_manager::WindowManager::get_main_window() {
        let _ = window.request_user_attention(Some(UserAttentionType::Critical));
    }
    Ok(())
}

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
        Ok(outcome) => {
            logging!(
                warn,
                Type::Core,
                "Failed to apply smart chain config: {}",
                outcome
            );
            Err(format!("smart chain config invalid: {}", outcome).into())
        }
        Err(err) => {
            logging!(
                error,
                Type::Core,
                "Failed to apply smart chain config: {}",
                err
            );
            Err(format!("failed to apply smart chain config: {}", err).into())
        }
    }
}
