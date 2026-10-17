//! The folder sidebar's view of the disk.
//!
//! Two decisions keep this small enough to maintain, and they are the answer
//! to the cost #149 names for a folder tree:
//!
//! - **One level per call.** Nothing here walks a tree. The sidebar asks for a
//!   folder's children when the reader expands it, so opening a folder with a
//!   `node_modules` in it costs one `read_dir` of its top level.
//! - **Only expanded folders are watched**, each non-recursively, on one
//!   watcher per window (one inotify instance or FSEvents stream, however
//!   many folders are open), and unwatched when collapsed, when the root
//!   changes, or when the window closes. A change emits `folder-changed` with
//!   the folder's path and the frontend re-reads that one level; there is no
//!   tree state on this side to drift.
//!
//! - **Links are not followed on Windows.** Touching a UNC path makes
//!   Windows connect to that host over SMB and offer the user's NTLM
//!   credentials, so a symlink or junction to `\\host\share` inside a folder
//!   someone unzipped or cloned would leak them the moment its parent was
//!   expanded, with no click (the attack #876 closed for documents). Deciding
//!   which link targets are safe means out-guessing every spelling Windows
//!   accepts for a remote path, every link along a target's path, and a link
//!   rewritten between check and use; leaving links out of the listing needs
//!   none of that. `read_dir` reports an entry's type from the directory's
//!   own records without opening it, so a listing never reaches a link's
//!   target, and the tree never offers a link to expand or open. Elsewhere a
//!   link is followed, and that can reach the network too: listing a folder
//!   stats each link to tell a folder from a file, and macOS autofs mounts
//!   `/net/<host>` on first access, so a link into `/net` contacts that host
//!   as soon as its parent is listed. NFS sends no reusable credential the
//!   way NTLM does, so links stay listed there.
//!
//! Which files Markpad can open is decided by the frontend, from the same
//! `MARKDOWN_LINK_EXTENSIONS` list the Open dialog filters on, so this module
//! has no third copy of it.

use crate::commands::blocking;
use crate::window_runtime::{coalesced, lock_recover};
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Window label -> its one folder watcher.
pub struct FolderWatcherState {
    windows: Mutex<HashMap<String, FolderWatch>>,
}

struct FolderWatch {
    watcher: RecommendedWatcher,
    /// Each watched folder as an event may spell it -> the path the frontend
    /// named. Both the named and the canonical spelling are keys: FSEvents
    /// reports resolved paths (`/private/tmp` for `/tmp`), inotify the named one.
    folders: Arc<Mutex<HashMap<PathBuf, String>>>,
}

impl FolderWatcherState {
    pub fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
        }
    }

    pub fn forget_window(&self, label: &str) {
        lock_recover(&self.windows).remove(label);
    }
}

/// The watched folders an event's paths are direct children of.
fn changed_folders(event: &notify::Event, folders: &HashMap<PathBuf, String>) -> Vec<String> {
    // Reads do not change a listing; everything else might.
    if matches!(event.kind, EventKind::Access(_)) {
        return Vec::new();
    }
    event
        .paths
        .iter()
        .filter_map(|path| folders.get(path.parent()?))
        .cloned()
        .collect()
}

fn new_folder_watch(handle: AppHandle, label: String) -> Result<FolderWatch, String> {
    let folders: Arc<Mutex<HashMap<PathBuf, String>>> = Arc::default();
    let changed: Arc<Mutex<HashSet<String>>> = Arc::default();
    let pending = changed.clone();
    let emit = coalesced(Duration::from_millis(200), move || {
        for folder in std::mem::take(&mut *lock_recover(&pending)) {
            let _ = handle.emit_to(label.as_str(), "folder-changed", folder);
        }
    });
    let watched = folders.clone();
    let watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            let Ok(event) = result else { return };
            let hits = changed_folders(&event, &lock_recover(&watched));
            if hits.is_empty() {
                return;
            }
            lock_recover(&changed).extend(hits);
            emit();
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;
    Ok(FolderWatch { watcher, folders })
}

/// The children of `dir`: folders first, then files, each sorted by name
/// without regard to case. Dot-entries are left out, as file managers do.
/// Entries whose type cannot be read are skipped rather than failing the
/// listing, so one broken symlink does not empty the folder.
pub fn list_folder(dir: &Path) -> Result<Vec<FolderEntry>, String> {
    if !dir.is_dir() {
        return Err("Not a directory".to_string());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // `file_type` does not follow links, so nothing below has touched
        // the link's target yet.
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // On Windows `is_symlink` covers symlinks and junctions alike. See
        // the module comment for why neither is listed there.
        let is_dir = if file_type.is_symlink() {
            if cfg!(windows) {
                continue;
            }
            // A link to a folder lists as one. A dangling link is left out.
            let Ok(metadata) = fs::metadata(entry.path()) else {
                continue;
            };
            metadata.is_dir()
        } else {
            file_type.is_dir()
        };
        entries.push(FolderEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn read_folder_entries(path: String) -> Result<Vec<FolderEntry>, String> {
    blocking(move || list_folder(Path::new(&path))).await
}

#[tauri::command]
pub async fn watch_folder(
    window: tauri::Window,
    handle: AppHandle,
    path: String,
) -> Result<(), String> {
    blocking(move || {
        let label = window.label().to_string();
        let state = handle.state::<FolderWatcherState>();
        let mut windows = lock_recover(&state.windows);
        let watch = match windows.entry(label.clone()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => entry.insert(new_folder_watch(handle.clone(), label)?),
        };
        watch
            .watcher
            .watch(Path::new(&path), RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
        let mut folders = lock_recover(&watch.folders);
        if let Ok(canonical) = fs::canonicalize(&path) {
            folders.insert(canonical, path.clone());
        }
        folders.insert(PathBuf::from(&path), path);
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn unwatch_folder(
    window: tauri::Window,
    state: tauri::State<'_, FolderWatcherState>,
    path: String,
) -> Result<(), String> {
    if let Some(watch) = lock_recover(&state.windows).get_mut(window.label()) {
        lock_recover(&watch.folders).retain(|_, named| *named != path);
        // A folder deleted since it was watched has no watch left to remove.
        let _ = watch.watcher.unwatch(Path::new(&path));
    }
    Ok(())
}

#[tauri::command]
pub fn unwatch_all_folders(
    window: tauri::Window,
    state: tauri::State<'_, FolderWatcherState>,
) -> Result<(), String> {
    state.forget_window(window.label());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs_safety::tests::temp_path;

    fn names(entries: &[FolderEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn folders_come_first_then_files_by_name_ignoring_case() {
        let dir = temp_path("folder-sort");
        fs::create_dir_all(dir.join("zeta")).unwrap();
        fs::create_dir_all(dir.join("Alpha")).unwrap();
        for file in ["b.md", "A.md", "c.txt"] {
            fs::write(dir.join(file), "").unwrap();
        }
        let entries = list_folder(&dir).unwrap();
        assert_eq!(names(&entries), ["Alpha", "zeta", "A.md", "b.md", "c.txt"]);
        assert!(entries[0].is_dir && entries[1].is_dir && !entries[2].is_dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dot_entries_are_hidden_and_only_one_level_is_read() {
        let dir = temp_path("folder-hidden");
        fs::create_dir_all(dir.join(".git/objects")).unwrap();
        fs::create_dir_all(dir.join("notes/deep")).unwrap();
        fs::write(dir.join(".env"), "").unwrap();
        fs::write(dir.join("notes/deep/x.md"), "").unwrap();
        let entries = list_folder(&dir).unwrap();
        assert_eq!(names(&entries), ["notes"]);
        assert_eq!(entries[0].path, dir.join("notes").to_string_lossy());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_link_is_left_out_on_windows_without_being_followed() {
        let dir = temp_path("folder-win-link");
        fs::create_dir_all(dir.join("real")).unwrap();
        // Creating a symlink needs Developer Mode or elevation; without it
        // there is nothing to test, and the listing code is unchanged.
        if std::os::windows::fs::symlink_dir(r"\\unreachable.invalid\share", dir.join("remote"))
            .is_err()
        {
            fs::remove_dir_all(&dir).unwrap();
            return;
        }
        let entries = list_folder(&dir).unwrap();
        assert_eq!(names(&entries), ["real"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_event_names_the_watched_folder_it_happened_in() {
        let folders = HashMap::from([
            (PathBuf::from("/tmp/notes"), "/tmp/notes".to_string()),
            (
                PathBuf::from("/private/tmp/notes"),
                "/tmp/notes".to_string(),
            ),
        ]);
        let event = |kind, path: &str| notify::Event::new(kind).add_path(PathBuf::from(path));
        let create = EventKind::Create(notify::event::CreateKind::File);
        assert_eq!(
            changed_folders(&event(create, "/tmp/notes/a.md"), &folders),
            ["/tmp/notes"]
        );
        assert_eq!(
            changed_folders(&event(create, "/private/tmp/notes/a.md"), &folders),
            ["/tmp/notes"],
            "FSEvents reports the resolved path"
        );
        assert!(changed_folders(&event(create, "/tmp/notes/sub/a.md"), &folders).is_empty());
        let read = EventKind::Access(notify::event::AccessKind::Read);
        assert!(changed_folders(&event(read, "/tmp/notes/a.md"), &folders).is_empty());
    }

    #[test]
    fn a_file_or_missing_path_is_not_a_folder() {
        let dir = temp_path("folder-missing");
        assert!(list_folder(&dir).is_err());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.md"), "").unwrap();
        assert!(list_folder(&dir.join("a.md")).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
