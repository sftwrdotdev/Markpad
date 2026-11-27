//! Portable mode on Windows (#1074). A `MarkpadData` folder next to
//! `Markpad.exe` holds everything Markpad otherwise keeps in the user profile:
//! the config files under `config`, and the webview's data (where the settings
//! live, in localStorage) under `webview`. Carry the folder with the exe and
//! the settings come along.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager, Runtime};

/// The folder whose presence next to the executable turns portable mode on.
pub const DATA_DIR_NAME: &str = "MarkpadData";

/// The portable data folder for an executable at `exe`, if the user made one.
fn data_dir_beside(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?.join(DATA_DIR_NAME);
    dir.is_dir().then_some(dir)
}

/// Decided once per launch: a folder made or removed while Markpad runs takes
/// effect on the next start, so one run never splits its files across two places.
fn data_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        if cfg!(windows) {
            data_dir_beside(&std::env::current_exe().ok()?)
        } else {
            None
        }
    })
    .as_deref()
}

/// Where Markpad keeps its config files. Every caller goes through here, so
/// nothing lands in the profile while portable mode is on.
#[allow(clippy::disallowed_methods)]
pub fn config_dir<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PathBuf> {
    match data_dir() {
        Some(dir) => Ok(dir.join("config")),
        None => app.path().app_config_dir(),
    }
}

/// The webview's data folder, or `None` for the platform default.
pub fn webview_dir() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("webview"))
}

/// The window-state plugin's file name. The plugin joins it onto the profile's
/// config dir, and joining an absolute path replaces the base, so portable
/// mode hands it the full path.
pub fn window_state_file() -> String {
    match data_dir() {
        Some(dir) => dir
            .join("config")
            .join(tauri_plugin_window_state::DEFAULT_FILENAME)
            .to_string_lossy()
            .into_owned(),
        None => tauri_plugin_window_state::DEFAULT_FILENAME.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("markpad-portable-{tag}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_data_folder_next_to_the_exe_turns_portable_mode_on() {
        let dir = temp_dir("on");
        fs::create_dir(dir.join(DATA_DIR_NAME)).unwrap();
        assert_eq!(
            data_dir_beside(&dir.join("Markpad.exe")),
            Some(dir.join(DATA_DIR_NAME))
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn without_the_folder_markpad_uses_the_profile() {
        let dir = temp_dir("off");
        assert_eq!(data_dir_beside(&dir.join("Markpad.exe")), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_with_the_folders_name_does_not_count() {
        let dir = temp_dir("file");
        fs::write(dir.join(DATA_DIR_NAME), "").unwrap();
        assert_eq!(data_dir_beside(&dir.join("Markpad.exe")), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
