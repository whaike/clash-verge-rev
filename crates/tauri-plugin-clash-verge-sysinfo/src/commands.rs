use parking_lot::RwLock;
use serde::Serialize;
use sysinfo::{ProcessesToUpdate, System};
use tauri::{AppHandle, Runtime, State, command};
use tauri_plugin_clipboard_manager::{ClipboardExt as _, Error};

use crate::Platform;

#[derive(Serialize)]
pub struct SystemInfo {
    pub system_name: String,
    pub system_version: String,
    pub system_kernel_version: String,
    pub system_arch: String,
    pub app_version: String,
    pub app_core_mode: String,
    pub app_is_admin: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSuggestion {
    pub name: String,
    pub path: String,
}

impl From<Platform> for SystemInfo {
    fn from(platform: Platform) -> Self {
        Self {
            system_name: platform.sysinfo.system_name,
            system_version: platform.sysinfo.system_version,
            system_kernel_version: platform.sysinfo.system_kernel_version,
            system_arch: platform.sysinfo.system_arch,
            app_version: platform.appinfo.app_version,
            app_core_mode: platform.appinfo.app_core_mode,
            app_is_admin: platform.appinfo.app_is_admin,
        }
    }
}

#[command]
pub fn get_system_info(state: State<'_, RwLock<Platform>>) -> Result<SystemInfo, Error> {
    let platform = state.inner().read();
    Ok(SystemInfo::from(platform.clone()))
}

/// 获取应用的运行时间（毫秒）
#[command]
pub fn get_app_uptime(state: State<'_, RwLock<Platform>>) -> Result<u128, Error> {
    Ok(state.inner().read().appinfo.app_startup_time.elapsed().as_millis())
}

/// 检查应用是否以管理员身份运行
#[command]
pub fn app_is_admin(state: State<'_, RwLock<Platform>>) -> Result<bool, Error> {
    Ok(state.inner().read().appinfo.app_is_admin)
}

/// Returns running processes whose executable name or path matches the user's
/// query. This is deliberately local-only; it neither launches nor restarts a
/// target application.
#[command]
pub fn find_running_processes(query: String) -> Result<Vec<ProcessSuggestion>, Error> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let mut processes = system
        .processes()
        .values()
        .filter_map(|process| {
            let name = process.name().to_string_lossy().into_owned();
            let path = process
                .exe()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            let matches = name.to_lowercase().contains(&query) || path.to_lowercase().contains(&query);
            matches.then_some(ProcessSuggestion { name, path })
        })
        .collect::<Vec<_>>();

    processes.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    processes.dedup_by(|left, right| left.name == right.name && left.path == right.path);
    Ok(processes)
}

#[command]
pub fn export_diagnostic_info<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, RwLock<Platform>>,
) -> Result<(), Error> {
    let info = state.inner().read().to_string();
    let clipboard = app_handle.clipboard();
    clipboard.write_text(info)
}
