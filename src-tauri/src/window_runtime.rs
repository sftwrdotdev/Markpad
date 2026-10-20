use crate::fs_safety::atomic_write;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct WatcherState {
    pub(crate) watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

/// The window Tauri builds at launch. Only startup tells it apart: it adopts a
/// remembered window when it has no snapshot of its own, takes the files the
/// launch was started with, and shows itself without taking focus. Its files
/// keep their pre-per-window names, so an older build still finds them.
pub const LAUNCH_LABEL: &str = "main";

pub struct AppState {
    /// Paths the launch was asked to open. `Some` until the launch window takes
    /// them; after that a path opened goes straight to a window.
    startup_files: Mutex<Option<Vec<String>>>,
    pub(crate) last_focused_viewer: Mutex<Option<String>>,
    window_registry: Mutex<HashMap<String, WindowMeta>>,
    window_counter: AtomicU64,
    /// Serialises the read-modify-write cycle over `pinned-tags.json`. Guards
    /// a critical section rather than a value, so the payload is `()` — see
    /// `update_pinned_tags` for why the whole cycle has to be inside it.
    pinned_tags: Mutex<()>,
    /// `Some` while a quit is in progress, holding the windows it has closed so
    /// far: a cancelled quit forgets them, since the user carries on without.
    quit: Mutex<Option<Vec<String>>>,
    /// Remembered windows are reopened once per launch, by the first caller.
    reopened: AtomicBool,
    /// Orphan backups already handed to a window this launch.
    claimed_recovery: Mutex<HashSet<String>>,
}

/// Locks `mutex`, recovering the guarded value if a previous holder panicked.
///
/// These mutexes guard plain bookkeeping — the window registry, pending
/// startup paths, the watcher map — none of which is left in a torn state by
/// a panic elsewhere. Propagating poisoning instead would turn one panic into
/// a permanently unusable registry: every later `set_window_meta`,
/// `list_viewer_windows` and window-destroyed handler would panic in turn.
///
/// `pinned_tags` is recovered on the same grounds even though it guards a
/// file: the only thing a panic inside the cycle can leave behind is the
/// pre-existing `pinned-tags.json`, because `atomic_write` publishes by
/// rename and a panic before it simply never publishes. There is no
/// half-applied state for the next holder to inherit, and propagating the
/// poison would instead make pinning fail for the rest of the session.
pub(crate) fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

impl AppState {
    pub fn new() -> Self {
        Self {
            startup_files: Mutex::new(Some(Vec::new())),
            last_focused_viewer: Mutex::new(None),
            window_registry: Mutex::new(HashMap::new()),
            window_counter: AtomicU64::new(0),
            pinned_tags: Mutex::new(()),
            quit: Mutex::new(None),
            reopened: AtomicBool::new(false),
            claimed_recovery: Mutex::new(HashSet::new()),
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct WindowMeta {
    number: u64,
    tag_name: Option<String>,
    tag_color: Option<String>,
    active_tab_title: String,
    tab_count: usize,
}

#[derive(Clone, serde::Serialize)]
pub struct WindowListEntry {
    label: String,
    #[serde(flatten)]
    meta: WindowMeta,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct PinnedTag {
    pub name: String,
    pub color: String,
    pub files: Vec<String>,
}

/// `name` in the app config dir, which is created if missing.
pub(crate) fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, crate::error::Error> {
    Ok(config_dir(app)?.join(name))
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn pinned_tags_path(app: &AppHandle) -> Result<PathBuf, crate::error::Error> {
    config_file(app, "pinned-tags.json")
}

/// Reads the pin list, treating an unreadable or unparseable file as empty.
///
/// Under `update_pinned_tags`'s lock the empty fallback can only be reached by
/// a file that is genuinely damaged from outside Markpad, never by a write in
/// progress: `atomic_write` publishes by rename, so a concurrent reader opens
/// either the whole old file or the whole new one.
fn read_pinned_tags_at(path: &Path) -> Vec<PinnedTag> {
    fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// Reads the pin list without taking the lock.
///
/// A plain read needs no lock. The file is only ever replaced by
/// `atomic_write`'s rename, so a reader racing a writer sees either the whole
/// previous list or the whole next one, and both are lists that Markpad
/// actually wrote. What is unsafe is not the read but the *cycle* — read,
/// mutate, write back — which is why only `update_pinned_tags` locks.
fn read_pinned_tags(app: &AppHandle) -> Vec<PinnedTag> {
    pinned_tags_path(app)
        .map(|path| read_pinned_tags_at(&path))
        .unwrap_or_default()
}

/// Applies `edit` to the pin list and writes the result back, with the whole
/// read-modify-write cycle held under `lock`.
///
/// `atomic_write` is not enough on its own, and the difference is easy to miss.
/// It rules out a *torn* file: the rename publishes the new list in one step,
/// so no reader ever sees half a JSON document. It says nothing about a *lost
/// update*, where both writers produce a whole, valid file and the second one
/// is built from a list it read before the first one landed:
///
/// ```text
/// window A: read [x] ─── add "a" ─────────── write [x, a]
/// window B:      read [x] ─── add "b" ─────────────────── write [x, b]
/// on disk:  [x]                             [x, a]        [x, b]   ← "a" gone
/// ```
///
/// Tauri runs commands on a thread pool and ⌘Q makes every window save its
/// pin from its own close handler at once, so this interleaving is the normal
/// case. Unlocked, this cycle was measured losing pins.
fn update_pinned_tags(
    lock: &Mutex<()>,
    path: &Path,
    edit: impl FnOnce(&mut Vec<PinnedTag>),
) -> Result<(), crate::error::Error> {
    let _guard = lock_recover(lock);
    let mut tags = read_pinned_tags_at(path);
    edit(&mut tags);
    let json = serde_json::to_string(&tags)?;
    atomic_write(path, json.as_bytes())?;
    Ok(())
}

/// Writes `color` and `files` to the pin named `name` and reports whether it
/// existed. Only the explicit pin passes `create`: a window saves its pin as it
/// ends, and another window may have unpinned the tag in the meantime.
fn save_pinned_tag_at(
    lock: &Mutex<()>,
    path: &Path,
    name: String,
    color: String,
    files: Vec<String>,
    create: bool,
) -> Result<bool, crate::error::Error> {
    let mut found = false;
    update_pinned_tags(lock, path, |tags| {
        if let Some(tag) = tags.iter_mut().find(|tag| tag.name == name) {
            tag.color = color;
            tag.files = files;
            found = true;
        } else if create {
            tags.push(PinnedTag { name, color, files });
        }
    })?;
    Ok(found)
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PinnedTagRename {
    Renamed,
    /// Another window unpinned the tag in the meantime.
    Missing,
    /// Another pin already holds the new name.
    Taken,
}

/// Renames a pin in place, keeping its files and taking the new colour. The
/// closing save finds the entry by the window's current name, so a rename the
/// file never heard of unpinned the window at close. A name another pin holds
/// is refused rather than merged: the two are separate groups the user made,
/// and folding one into the other could not be undone.
fn rename_pinned_tag_at(
    lock: &Mutex<()>,
    path: &Path,
    old_name: String,
    name: String,
    color: String,
) -> Result<PinnedTagRename, crate::error::Error> {
    let mut outcome = PinnedTagRename::Missing;
    update_pinned_tags(lock, path, |tags| {
        if name != old_name && tags.iter().any(|tag| tag.name == name) {
            outcome = PinnedTagRename::Taken;
        } else if let Some(tag) = tags.iter_mut().find(|tag| tag.name == old_name) {
            tag.name = name;
            tag.color = color;
            outcome = PinnedTagRename::Renamed;
        }
    })?;
    Ok(outcome)
}

fn remove_pinned_tag_at(
    lock: &Mutex<()>,
    path: &Path,
    name: String,
) -> Result<(), crate::error::Error> {
    update_pinned_tags(lock, path, move |tags| {
        tags.retain(|tag| tag.name != name);
    })
}

#[tauri::command]
pub fn list_pinned_tags(app: AppHandle) -> Vec<PinnedTag> {
    read_pinned_tags(&app)
}

#[tauri::command]
pub fn save_pinned_tag(
    app: AppHandle,
    name: String,
    color: String,
    files: Vec<String>,
) -> Result<(), String> {
    let path = pinned_tags_path(&app)?;
    let state = app.state::<AppState>();
    save_pinned_tag_at(&state.pinned_tags, &path, name, color, files, true)
        .map(|_| ())
        .map_err(String::from)
}

#[tauri::command]
pub fn update_pinned_tag(
    app: AppHandle,
    name: String,
    color: String,
    files: Vec<String>,
) -> Result<bool, String> {
    let path = pinned_tags_path(&app)?;
    let state = app.state::<AppState>();
    save_pinned_tag_at(&state.pinned_tags, &path, name, color, files, false).map_err(String::from)
}

#[tauri::command]
pub fn rename_pinned_tag(
    app: AppHandle,
    old_name: String,
    name: String,
    color: String,
) -> Result<PinnedTagRename, String> {
    let path = pinned_tags_path(&app)?;
    let state = app.state::<AppState>();
    rename_pinned_tag_at(&state.pinned_tags, &path, old_name, name, color).map_err(String::from)
}

#[tauri::command]
pub fn remove_pinned_tag(app: AppHandle, name: String) -> Result<(), String> {
    let path = pinned_tags_path(&app)?;
    let state = app.state::<AppState>();
    remove_pinned_tag_at(&state.pinned_tags, &path, name).map_err(String::from)
}

#[tauri::command]
pub fn set_window_meta(
    window: tauri::Window,
    state: State<'_, AppState>,
    tag_name: Option<String>,
    tag_color: Option<String>,
    active_tab_title: String,
    tab_count: usize,
) {
    let label = window.label().to_string();
    if !is_viewer_label(&label) {
        return;
    }
    let mut registry = lock_recover(&state.window_registry);
    let entry = registry.entry(label).or_insert_with(|| WindowMeta {
        number: state.window_counter.fetch_add(1, Ordering::SeqCst) + 1,
        tag_name: None,
        tag_color: None,
        active_tab_title: String::new(),
        tab_count: 0,
    });
    entry.tag_name = tag_name;
    entry.tag_color = tag_color;
    entry.active_tab_title = active_tab_title;
    entry.tab_count = tab_count;
}

/// Whether a window other than `label` currently carries `name` as its tag.
///
/// A window tag names a *window*, and `save_pinned_tag_at` keys the pin file by
/// that name alone: it finds the entry whose `name` matches and replaces its
/// whole `files` list. Two windows holding one name therefore have one pinned
/// document set between them, and the last one to write wins — silently, since
/// neither window can see the other's list. #424's `pinned_tags` lock removed
/// the *concurrent* form of that loss (two interleaved read-modify-writes); it
/// deliberately says nothing about two serialized writes that each replace a
/// payload the other wrote, which is the ordinary outcome of two windows
/// sharing a name.
///
/// The answer comes out of `window_registry` rather than a new registry of tag
/// names, because the registry already holds `tag_name` per window label and
/// the frontend keeps it current through `set_window_meta`. That makes it live
/// data with the two properties a name-holder table needs and is awkward to
/// give one: `WindowEvent::Destroyed` removes the entry, so closing a window
/// releases its name with no bookkeeping, and it lives in memory, so a crash
/// leaves nothing behind to block names nobody holds any more.
fn tag_held_by_another_window(
    registry: &HashMap<String, WindowMeta>,
    label: &str,
    name: &str,
) -> bool {
    registry
        .iter()
        .any(|(other, meta)| other != label && meta.tag_name.as_deref() == Some(name))
}

#[tauri::command]
pub fn is_window_tag_taken(
    window: tauri::Window,
    state: State<'_, AppState>,
    name: String,
) -> bool {
    let registry = lock_recover(&state.window_registry);
    tag_held_by_another_window(&registry, window.label(), &name)
}

#[tauri::command]
pub fn list_viewer_windows(state: State<'_, AppState>) -> Vec<WindowListEntry> {
    let registry = lock_recover(&state.window_registry);
    let mut list: Vec<WindowListEntry> = registry
        .iter()
        .map(|(label, meta)| WindowListEntry {
            label: label.clone(),
            meta: meta.clone(),
        })
        .collect();
    list.sort_by_key(|entry| entry.meta.number);
    list
}

/// Starts a quit (`true`) or ends one a close cancelled (`false`), returning
/// the windows a cancelled quit had already closed.
fn update_quit(quit: &Mutex<Option<Vec<String>>>, quitting: bool) -> Vec<String> {
    let mut quit = lock_recover(quit);
    if quitting {
        quit.get_or_insert_with(Vec::new);
        return Vec::new();
    }
    quit.take().unwrap_or_default()
}

/// A window closed during a quit keeps its snapshot, since the session ends
/// with it. If the quit is then cancelled the user carries on without those
/// windows, so they are forgotten as if each had been closed on its own. Their
/// unsaved backups stay: with no snapshot they are orphans the next launch adopts.
/// ponytail: a window whose close was already under way when the quit was
/// cancelled, and is destroyed after, is still remembered.
#[tauri::command]
pub fn set_quitting(
    app: AppHandle,
    state: State<'_, AppState>,
    quitting: bool,
) -> Result<(), String> {
    let closed = update_quit(&state.quit, quitting);
    if closed.is_empty() {
        return Ok(());
    }
    let config = config_dir(&app)?;
    for label in closed {
        forget_window_state_in(&config, &label)?;
    }
    Ok(())
}

/// Hot exit applies when the app is quitting or no other viewer window is open,
/// so the app exits with this window. Two windows closing at once each still see
/// the other and ask: a race costs a prompt, never hides content.
fn keeps_unsaved_on_close_for<'a>(
    quitting: bool,
    own: &str,
    open: impl IntoIterator<Item = &'a str>,
) -> bool {
    quitting
        || !open
            .into_iter()
            .any(|label| label != own && is_viewer_label(label))
}

#[tauri::command]
pub fn keeps_unsaved_on_close(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
) -> bool {
    // Tauri's own window list, not the registry: a window counts as open before
    // its frontend has registered.
    let open = app.webview_windows();
    keeps_unsaved_on_close_for(
        lock_recover(&state.quit).is_some(),
        window.label(),
        open.keys().map(String::as_str),
    )
}

#[tauri::command]
pub fn offer_tab_to_window(
    app: AppHandle,
    broker: State<'_, crate::tab_transfer::TabTransferBroker>,
    target_label: String,
    token: String,
) -> Result<(), String> {
    if app.get_webview_window(&target_label).is_none() {
        return Err(format!("no such window: {target_label}"));
    }
    broker.set_target_label(&token, target_label.clone())?;
    app.emit_to(target_label.as_str(), "tab-transfer-offer", token)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn focus_window(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no such window: {label}"))?;
    bring_to_front(&window);
    Ok(())
}

/// Consumed by the launch window's first show. See `show_window`.
static MAIN_WINDOW_SHOWN: AtomicBool = AtomicBool::new(false);

/// Reveals a window that was built hidden.
///
/// The launch window is built hidden so no empty frame is on screen while the
/// webview boots, and the frontend calls this once it has mounted — seconds
/// after launch, by which time the user has usually gone back to whatever they
/// were doing. Activating then is wrong, and `set_focus` is not a polite
/// request to activate: it is each platform's override for the focus-stealing
/// prevention the OS applies on the user's behalf — `SetForegroundWindow` on
/// Windows, with a *synthesized Alt keypress* as the fallback when the OS
/// refuses, `activateIgnoringOtherApps:` on macOS, `present_with_time` passed
/// `GDK_CURRENT_TIME` on Linux. Shown without it, the window appears behind
/// whatever the user moved on to and waits there (#702).
///
/// Only that first show is quiet. Every other caller is answering something the
/// user just did — a detached tab window revealing itself, or the close walk
/// bringing its window up so the dialog is not hidden behind another — and each
/// of those must still come to the front.
#[tauri::command]
pub async fn show_window(window: tauri::Window) {
    let is_cold_start =
        window.label() == LAUNCH_LABEL && !MAIN_WINDOW_SHOWN.swap(true, Ordering::Relaxed);

    let _ = window.show();

    if is_cold_start {
        return;
    }

    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// The launch window's snapshot keeps its pre-per-window name, so an existing
/// session needs no migration and an older build still finds it.
const MAIN_WINDOW_STATE: &str = "window-state-v2.json";
/// Every other remembered window has a snapshot here, named by its label.
/// One file per window: N windows closing at once never write the same file.
const WINDOW_STATE_DIR: &str = "window-state";
const MAIN_RESTORE_PROGRESS: &str = "restore-progress-v1.json";
const RESTORE_PROGRESS_DIR: &str = "restore-progress";

fn config_dir(app: &AppHandle) -> Result<PathBuf, crate::error::Error> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// `label`'s file in a per-window directory. Only `window-*` windows have one:
/// the launch window has its own file, and anything else is not a window
/// startup reopens.
fn secondary_window_file(dir: &Path, label: &str) -> Result<PathBuf, String> {
    if !label.starts_with("window-") {
        return Err(format!("not a secondary window label: {label}"));
    }
    label_file(dir, label)
}

fn window_state_path_in(config: &Path, label: &str) -> Result<PathBuf, String> {
    if label == LAUNCH_LABEL {
        return Ok(config.join(MAIN_WINDOW_STATE));
    }
    secondary_window_file(&config.join(WINDOW_STATE_DIR), label)
}

fn restore_progress_path_in(config: &Path, label: &str) -> Result<PathBuf, String> {
    if label == LAUNCH_LABEL {
        return Ok(config.join(MAIN_RESTORE_PROGRESS));
    }
    secondary_window_file(&config.join(RESTORE_PROGRESS_DIR), label)
}

/// Writes a file Markpad owns in one of its per-window directories. Like
/// `atomic_write`, but refuses to follow a symlink into a document.
fn write_owned_file(path: &Path, json: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err("target is not a regular file".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    atomic_write(path, json.as_bytes()).map_err(|error| error.to_string())
}

fn save_window_state_in(config: &Path, label: &str, json: &str) -> Result<(), String> {
    let path = window_state_path_in(config, label)?;
    write_owned_file(&path, json)
}

fn load_window_state_in(config: &Path, label: &str) -> Option<String> {
    fs::read_to_string(window_state_path_in(config, label).ok()?).ok()
}

/// A window closed on its own is not reopened. Its crash-guard breadcrumb goes with it.
fn forget_window_state_in(config: &Path, label: &str) -> Result<(), String> {
    remove_if_exists(&window_state_path_in(config, label)?)?;
    remove_if_exists(&restore_progress_path_in(config, label)?)
}

fn remove_dir_if_exists(dir: &Path) -> Result<(), String> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Every window's snapshot, for the setting that turns restore off.
fn clear_window_state_in(config: &Path) -> Result<(), String> {
    remove_if_exists(&config.join(MAIN_WINDOW_STATE))?;
    remove_dir_if_exists(&config.join(WINDOW_STATE_DIR))?;
    remove_dir_if_exists(&config.join(RESTORE_PROGRESS_DIR))
}

/// The secondary windows that were open when the last session ended.
fn remembered_window_labels_in(config: &Path) -> Vec<String> {
    let dir = config.join(WINDOW_STATE_DIR);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut labels: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name();
            let label = name.to_str()?.strip_suffix(".json")?.to_string();
            secondary_window_file(&dir, &label).ok()?;
            Some(label)
        })
        .collect();
    labels.sort();
    labels
}

/// Persists the calling window's restore snapshot atomically.
///
/// This runs as the window changes and while it closes, when the WebKit
/// storage process may already be tearing down, so a partial write is a
/// realistic outcome, not a theoretical one. `fs::write` truncates first and
/// then streams, so a crash mid-write leaves behind half a JSON document, and
/// the next launch restores no tabs at all. `atomic_write` publishes the new
/// snapshot with a rename: the file on disk is either entirely the old
/// session or entirely the new one.
///
/// Off the main thread: the two fsyncs cost ~8 ms, and on it every window
/// freezes for that long. The caller still awaits the write.
#[tauri::command]
pub async fn save_window_state(
    window: tauri::Window,
    app: AppHandle,
    json: String,
) -> Result<(), String> {
    let config = config_dir(&app)?;
    let label = window.label().to_string();
    crate::commands::blocking(move || save_window_state_in(&config, &label, &json)).await
}

#[tauri::command]
pub fn load_window_state(window: tauri::Window, app: AppHandle) -> Option<String> {
    load_window_state_in(&config_dir(&app).ok()?, window.label())
}

#[tauri::command]
pub fn forget_window_state(window: tauri::Window, app: AppHandle) -> Result<(), String> {
    forget_window_state_in(&config_dir(&app)?, window.label())
}

#[tauri::command]
pub fn clear_window_state(app: AppHandle) -> Result<(), String> {
    clear_window_state_in(&config_dir(&app)?)
}

/// Rebuilds each remembered secondary window under its saved label. Each one
/// restores its own snapshot and unsaved backup. Every window asks after its
/// own restore; only the first call of a launch does anything, so a window
/// opened later cannot resurrect one that is closing.
///
/// Async for the reason `create_transfer_window` is.
#[tauri::command]
pub async fn reopen_remembered_windows(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if state.reopened.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let config = config_dir(&app)?;
    for label in remembered_window_labels_in(&config) {
        if app.get_webview_window(&label).is_none() {
            if let Err(error) = build_viewer_window(&app, &label) {
                eprintln!("Failed to reopen window {label}: {error}");
            }
        }
    }
    Ok(())
}

/// The remembered window the launch window takes over when it has no
/// snapshot of its own, so a launch never shows an extra empty window.
fn adoption_source(launch_has_snapshot: bool, remembered: &[String]) -> Option<&str> {
    if launch_has_snapshot {
        return None;
    }
    remembered.first().map(String::as_str)
}

fn rename_if_exists(from: &Path, to: &Path) -> Result<(), String> {
    match fs::rename(from, to) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

/// Moves `from`'s entry in the window-state plugin's file to the launch
/// window. Geometry is cosmetic, so a file that cannot be read is left alone.
fn adopt_geometry(path: &Path, from: &str) {
    let Some(mut entries) = fs::read_to_string(path).ok().and_then(|json| {
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json).ok()
    }) else {
        return;
    };
    let Some(entry) = entries.remove(from) else {
        return;
    };
    entries.insert(LAUNCH_LABEL.to_string(), entry);
    if let Ok(json) = serde_json::to_string(&entries) {
        let _ = atomic_write(path, json.as_bytes());
    }
}

/// Hands `from`'s snapshot, breadcrumb, unsaved backup and geometry to the
/// launch window. The snapshot moves last: it is what makes `from` a
/// remembered window, so a launch killed partway adopts it again next time.
/// A backup the launch window already has is never overwritten; `from`'s then
/// stays an orphan and is claimed at startup like any other.
fn adopt_window_in(config: &Path, from: &str) -> Result<(), String> {
    let recovery = config.join(UNSAVED_RECOVERY_DIR);
    let own_backup = label_file(&recovery, LAUNCH_LABEL)?;
    if !own_backup.exists() {
        rename_if_exists(&label_file(&recovery, from)?, &own_backup)?;
    }
    adopt_geometry(
        &config.join(tauri_plugin_window_state::DEFAULT_FILENAME),
        from,
    );
    rename_if_exists(
        &restore_progress_path_in(config, from)?,
        &restore_progress_path_in(config, LAUNCH_LABEL)?,
    )?;
    fs::rename(
        window_state_path_in(config, from)?,
        window_state_path_in(config, LAUNCH_LABEL)?,
    )
    .map_err(|error| error.to_string())
}

/// Runs before the window-state plugin reads its file and before the launch
/// window is built, so the window comes up with the adopted geometry.
pub fn adopt_remembered_window(app: &AppHandle) {
    let Ok(config) = config_dir(app) else {
        return;
    };
    let has_snapshot = config.join(MAIN_WINDOW_STATE).exists();
    let remembered = remembered_window_labels_in(&config);
    if let Some(from) = adoption_source(has_snapshot, &remembered) {
        if let Err(error) = adopt_window_in(&config, from) {
            eprintln!("Failed to adopt window {from}: {error}");
        }
    }
}

const UNSAVED_RECOVERY_DIR: &str = "unsaved-recovery";

fn unsaved_recovery_dir(app: &AppHandle) -> Result<PathBuf, crate::error::Error> {
    config_file(app, UNSAVED_RECOVERY_DIR)
}

fn label_file(dir: &Path, label: &str) -> Result<PathBuf, String> {
    if label.is_empty()
        || !label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(format!("invalid window label: {label}"));
    }
    Ok(dir.join(format!("{label}.json")))
}

fn remove_recovery_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Each window replaces only its own snapshot, never a document on disk.
fn save_unsaved_recovery_at(dir: &Path, label: &str, json: &str) -> Result<(), String> {
    let path = label_file(dir, label)?;
    if json.trim() == "[]" {
        return remove_recovery_file(&path);
    }
    write_owned_file(&path, json)
}

fn load_unsaved_recovery_at(dir: &Path) -> Result<Vec<(String, String)>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut snapshots = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(label) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
            continue;
        };
        if label_file(dir, label).is_err() || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        // One unreadable file must not hide the others. It arrives empty, which
        // the frontend rejects as a corrupt record and leaves on disk.
        let json = fs::read_to_string(entry.path()).unwrap_or_default();
        snapshots.push((label.to_string(), json));
    }
    snapshots.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(snapshots)
}

fn clear_unsaved_recovery_at(dir: &Path, labels: &[String]) -> Result<(), String> {
    // Validate the whole request before deleting any snapshot.
    let paths = labels
        .iter()
        .map(|label| label_file(dir, label))
        .collect::<Result<Vec<_>, _>>()?;
    for path in paths {
        remove_recovery_file(&path)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn save_unsaved_recovery(
    window: tauri::WebviewWindow,
    app: AppHandle,
    json: String,
) -> Result<(), String> {
    let dir = unsaved_recovery_dir(&app)?;
    let label = window.label().to_string();
    crate::commands::blocking(move || save_unsaved_recovery_at(&dir, &label, &json)).await
}

/// The backups a window takes in at startup: its own, and each orphan no other
/// window has taken yet. An orphan is a backup whose window is not open and
/// has no snapshot, so nothing will reopen it — after a crash before the
/// window's first snapshot, say, or with restore off.
fn claim_recovery_records(
    records: Vec<(String, String)>,
    own: &str,
    is_orphan: impl Fn(&str) -> bool,
    claimed: &mut HashSet<String>,
) -> Vec<(String, String)> {
    records
        .into_iter()
        .filter(|(label, _)| label == own || (is_orphan(label) && claimed.insert(label.clone())))
        .collect()
}

/// Whichever window asks first gets the orphans, once: two windows starting
/// together must not both restore the same unsaved buffer.
#[tauri::command]
pub async fn claim_unsaved_recovery(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<(String, String)>, String> {
    let dir = unsaved_recovery_dir(&app)?;
    let config = config_dir(&app)?;
    let records = crate::commands::blocking(move || load_unsaved_recovery_at(&dir)).await?;
    let open = app.webview_windows();
    let state = app.state::<AppState>();
    let mut claimed = lock_recover(&state.claimed_recovery);
    Ok(claim_recovery_records(
        records,
        window.label(),
        |label| {
            !open.contains_key(label)
                && !window_state_path_in(&config, label).is_ok_and(|path| path.exists())
        },
        &mut claimed,
    ))
}

#[tauri::command]
pub async fn clear_unsaved_recovery(app: AppHandle, labels: Vec<String>) -> Result<(), String> {
    let dir = unsaved_recovery_dir(&app)?;
    crate::commands::blocking(move || clear_unsaved_recovery_at(&dir, &labels)).await
}

/// Publishes the restore breadcrumb by rename, but without `atomic_write`'s
/// fsyncs.
///
/// The breadcrumb is the record a launch leaves before it reads a document, so
/// that the launch after it knows which document killed it. It lives here for
/// the reason the snapshot does: `localStorage.setItem` is an async message to
/// the WebKit storage process, and the abnormal termination this record exists
/// to survive is exactly the event that loses messages in flight. Keeping the
/// one piece of state whose whole job is to outlive a kill in the store this
/// codebase had already proved does not survive one is what left #201's
/// reporter relaunching into the same hang.
///
/// The rename is not decoration: `fs::write` truncates before it writes, so a
/// process killed mid-call leaves an empty file — and an empty breadcrumb
/// reads as "nothing was interrupted", the one direction this record must
/// never fail in. What it does *not* need is durability past a power cut. The
/// event it survives is the process dying, and a rename the kernel has
/// accepted is visible to every later process whether or not it reached the
/// platter; after a power cut the breadcrumb is simply absent and startup
/// behaves as it did before this file existed. That is worth separating from
/// `atomic_write`, which runs on the user's documents and must survive the
/// stronger event, because this one runs once per document on every launch:
/// measured on macOS/APFS with a 122-byte payload, `atomic_write`'s two fsyncs
/// cost ~8 ms per call against ~0.2 ms for temp-file-plus-rename.
fn write_restore_progress(path: &Path, json: &str) -> std::io::Result<()> {
    // Two Markpad processes (Windows, Linux), or two windows of one, would
    // otherwise share a temp name and the loser would delete the winner's file
    // out from under its rename.
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("restore-progress");
    let temp = path.with_file_name(format!(".{name}-{}.tmp", std::process::id()));
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let write = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        std::io::Write::write_all(&mut file, json.as_bytes())?;
        // Closed before the rename: Windows tolerates renaming an open handle
        // only because Rust opens with FILE_SHARE_DELETE, which is a detail of
        // the standard library rather than a promise to this caller.
        drop(file);
        fs::rename(&temp, path)
    })();
    if let Err(error) = write {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

/// Each window guards its own restore: the breadcrumb is keyed by the caller's label.
#[tauri::command]
pub fn save_restore_progress(
    window: tauri::Window,
    app: AppHandle,
    json: String,
) -> Result<(), String> {
    let path = restore_progress_path_in(&config_dir(&app)?, window.label())?;
    write_restore_progress(&path, &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_restore_progress(window: tauri::Window, app: AppHandle) -> Option<String> {
    fs::read_to_string(restore_progress_path_in(&config_dir(&app).ok()?, window.label()).ok()?).ok()
}

#[tauri::command]
pub fn clear_restore_progress(window: tauri::Window, app: AppHandle) -> Result<(), String> {
    remove_if_exists(&restore_progress_path_in(
        &config_dir(&app)?,
        window.label(),
    )?)
}

/// A document window: the launch one or any other.
fn is_viewer_label(label: &str) -> bool {
    label == LAUNCH_LABEL || label.starts_with("window-")
}

pub fn bring_to_front(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Where a file opened while the app runs goes: the focused window, else the
/// one focused last, else the launch window, else any open one.
fn delivery_label<'a>(
    focused: Option<&'a str>,
    last_focused: Option<&'a str>,
    open: &[&'a str],
) -> Option<&'a str> {
    focused
        .or(last_focused.filter(|label| open.contains(label)))
        .or_else(|| open.iter().copied().find(|label| *label == LAUNCH_LABEL))
        .or_else(|| open.first().copied())
}

pub fn pick_delivery_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app.webview_windows();
    let mut open: Vec<&str> = windows
        .keys()
        .map(String::as_str)
        .filter(|label| is_viewer_label(label))
        .collect();
    open.sort();
    let focused = open
        .iter()
        .copied()
        .find(|label| windows[*label].is_focused().unwrap_or(false));
    let state = app.state::<AppState>();
    let last = lock_recover(&state.last_focused_viewer).clone();
    let label = delivery_label(focused, last.as_deref(), &open)?;
    windows.get(label).cloned()
}

/// A file macOS opened. Until the launch window has taken the launch's files it
/// joins them, so it lands there and in no other window; after that it goes
/// where `pick_delivery_window` says.
#[cfg(target_os = "macos")]
pub fn deliver_opened_path(app: &AppHandle, path: String) {
    let state = app.state::<AppState>();
    let target = {
        let mut pending = lock_recover(&state.startup_files);
        match pending.as_mut() {
            Some(paths) => {
                paths.push(path.clone());
                app.get_webview_window(LAUNCH_LABEL)
            }
            None => pick_delivery_window(app),
        }
    };
    if let Some(window) = target {
        let _ = app.emit_to(window.label(), "file-path", path);
        bring_to_front(&window);
    }
}

/// The openable paths named on a command line, in order, resolved against the
/// directory the command was run from.
///
/// argv is the one path source nobody vetted. Every other way a path enters is
/// narrower: the file picker returns a file that exists, and macOS's
/// `RunEvent::Opened` carries a URL Launch Services already resolved to a real
/// file it decided Markpad handles. Here the shell hands over whatever was
/// typed, and what comes back goes straight to the frontend's `loadMarkdown`,
/// so it has to be a path a document could plausibly live at.
///
/// Relative arguments are resolved rather than left for the eventual read to
/// resolve against the process's own directory. Both answer the same at
/// launch, but the resolved string is what the tab, the recent-files list and
/// the watcher keep — a bare `notes.md` in the recent list names whatever
/// directory the NEXT launch happens to start in.
///
/// Dropped, silently, because there is nothing to open and no channel here to
/// report on:
/// - a directory, and any argument with a trailing separator, which spells a
///   directory whether or not one exists there. `markpad ~/notes/` otherwise
///   opens a tab whose path is a directory: every read of it fails, and the
///   tab has a path so `serializeState` persists it — the failure then repeats
///   on every later launch until the user closes the tab.
/// - the empty string, which names no file at all.
///
/// A path that does not exist is KEPT. `markpad draft.md` naming a file yet to
/// be written is the request `vim` and `code` answer with an empty buffer at
/// that name, and nothing here can tell it from a typo; dropping it would
/// answer a deliberate request with an empty window. An existing file that is
/// not Markdown is kept too — Markpad's own Open dialog offers "All Files", so
/// the extension is not what decides whether a path is openable.
pub fn startup_paths(args: &[String], cwd: &Path) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
        .filter_map(|arg| {
            if arg.ends_with(std::path::is_separator) {
                return None;
            }
            let path = Path::new(arg);
            let resolved = if path.is_absolute() {
                path.to_path_buf()
            } else {
                cwd.join(path)
            };
            if resolved.is_dir() {
                return None;
            }
            Some(resolved.display().to_string())
        })
        .collect()
}

pub fn handle_single_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    let Some(window) = pick_delivery_window(app) else {
        return;
    };
    // One event per path, the way `RunEvent::Opened` delivers a
    // multi-file open on macOS: the `file-path` listener takes a single path.
    for path in startup_paths(&args, Path::new(&cwd)) {
        let _ = app.emit_to(window.label(), "file-path", path);
    }
    bring_to_front(&window);
}

/// Creates the destination window for a tab transfer. Its label carries the
/// token, so the new frontend knows which transfer to claim.
///
/// Async on purpose: a sync command runs on the main thread, and WebView2
/// deadlocks building a window there (tauri-apps/tauri#12521).
#[tauri::command]
pub async fn create_transfer_window(app: AppHandle, token: String) -> Result<(), String> {
    build_viewer_window(&app, &crate::tab_transfer::destination_label(&token))
}

/// The one factory for secondary windows: built hidden, the frontend shows it.
fn build_viewer_window(app: &AppHandle, label: &str) -> Result<(), String> {
    #[allow(unused_mut)]
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
            .title("Markpad")
            .inner_size(1000.0, 800.0)
            .min_inner_size(400.0, 300.0)
            .visible(false)
            .resizable(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .shadow(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    let _ = window.set_shadow(true);
    Ok(())
}

/// The path a watch for `target` is armed on: its parent directory.
///
/// Not `target` itself, which is what this used to be. A Linux `inotify` watch
/// resolves the path once and then follows the INODE, and `atomic_write` — like
/// VS Code, Vim, JetBrains and Emacs — saves by writing a temp file alongside
/// and renaming it over the top. That leaves a new inode at the same path, so
/// the watch was left holding the unlinked old one: after the first save, its
/// own or anyone else's, the watcher on Linux reported nothing for the rest of
/// the session, and the callback swallowed the error that said so.
/// `watch_survives_rename` below is that failure, pinned per platform.
///
/// A directory watch has no such problem, because the directory is the thing
/// whose entries changed. The cost is hearing about every sibling file, which
/// `event_concerns` drops on a name comparison — cheaper than the emit it
/// replaces.
///
/// Falls back to the target itself when there is no usable parent (a bare
/// relative filename, or a filesystem root), which keeps the previous
/// behaviour for the cases a directory watch cannot serve.
fn watch_root(target: &Path) -> PathBuf {
    match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() && target.file_name().is_some() => {
            parent.to_path_buf()
        }
        _ => target.to_path_buf(),
    }
}

/// Whether `event` is about the watched file rather than one of its neighbours.
///
/// Compares file names, not whole paths: the watch covers exactly one
/// directory, so the name is already unambiguous within it, and the platforms
/// do not agree on how to spell the directory back to us (macOS reports
/// `/private/var/...` for a path opened as `/var/...`). A rename that brings a
/// different file to this name is reported too, which is right — the file at
/// this path changed.
///
/// `atomic_write`'s temp file is a sibling with a different name, so a save
/// emits for the rename and not for the temp write that precedes it.
///
/// `None` means the watch is on the file itself (see `watch_root`), where
/// there is nothing to filter out.
fn event_concerns(event: &notify::Event, file_name: Option<&OsStr>) -> bool {
    match file_name {
        None => true,
        Some(name) => event.paths.iter().any(|p| p.file_name() == Some(name)),
    }
}

/// Turns a burst of calls into one call of `f`, `delay` after the first.
///
/// A save is several events — an editor's temp write and rename, or a
/// truncate and a write — and each `file-changed` is a full reload. Calls
/// that land while one is pending ride on it; it runs after them, so it sees
/// their result. The flag is cleared before `f` runs, so a call made while
/// `f` is running schedules another rather than being lost. A file written
/// continuously still emits every `delay`, where a debounce would wait for it
/// to go quiet.
pub(crate) fn coalesced(
    delay: Duration,
    f: impl Fn() + Send + Sync + 'static,
) -> impl Fn() + Send + 'static {
    let f = Arc::new(f);
    let pending = Arc::new(AtomicBool::new(false));
    move || {
        if pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let (f, pending) = (f.clone(), pending.clone());
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            pending.store(false, Ordering::SeqCst);
            f();
        });
    }
}

pub fn watch_file(
    window: tauri::Window,
    handle: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let event_label = label.clone();
    let watched_path = path.clone();

    // The DIRECTORY, not the file — see `watch_root`. The filename is kept so
    // the callback can drop everything else that happens in it.
    let target = Path::new(&path);
    let file_name = target.file_name().map(OsStr::to_os_string);
    let root = watch_root(target);

    // Build and arm the replacement *before* touching the watcher already
    // registered for this window. Dropping the old one first meant a failure
    // in either step below left the window with no watcher at all: the
    // frontend only logs the error, so external edits would silently stop
    // being reported for the rest of the session. Inserting last swaps them
    // in one step — the map drops the previous watcher, which unregisters it.
    let emit = coalesced(Duration::from_millis(150), move || {
        let _ = handle.emit_to(event_label.as_str(), "file-changed", watched_path.clone());
    });
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            let Ok(event) = result else { return };
            if !event_concerns(&event, file_name.as_deref()) {
                return;
            }
            emit();
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    lock_recover(&state.watchers).insert(label, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_file(window: tauri::Window, state: State<'_, WatcherState>) -> Result<(), String> {
    lock_recover(&state.watchers).remove(window.label());
    Ok(())
}

/// The launch's files, handed once to the launch window. Every window asks;
/// the others, and any later ask, get nothing, so a new window never reopens
/// the files the app was started with.
#[tauri::command]
pub fn send_markdown_path(window: tauri::Window, state: State<'_, AppState>) -> Vec<String> {
    if window.label() != LAUNCH_LABEL {
        return Vec::new();
    }
    let Some(opened) = lock_recover(&state.startup_files).take() else {
        return Vec::new();
    };
    let args: Vec<String> = std::env::args().collect();
    let mut files = startup_paths(&args, &std::env::current_dir().unwrap_or_default());
    for path in opened.into_iter().rev() {
        if !files.contains(&path) {
            files.insert(0, path);
        }
    }
    files
}

/// What the window-state plugin keeps for every window.
pub fn geometry_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;
    StateFlags::SIZE
        | StateFlags::POSITION
        | StateFlags::MAXIMIZED
        | StateFlags::VISIBLE
        | StateFlags::FULLSCREEN
}

/// Writes window geometry while the app runs. The plugin only saves on a
/// clean exit, so a crash or kill brought every window back at its default
/// size. A move or resize schedules one save of all windows 500 ms later,
/// the bound the session snapshots use.
/// ponytail: the plugin writes its file with `fs::write`, not by rename, so a
/// kill mid-write can lose every window's geometry once; the session itself
/// is unaffected.
pub struct GeometrySaver(Mutex<Box<dyn Fn() + Send>>);

impl GeometrySaver {
    pub fn new(app: AppHandle) -> Self {
        Self(Mutex::new(Box::new(coalesced(
            Duration::from_millis(500),
            move || {
                use tauri_plugin_window_state::AppHandleExt;
                if let Err(error) = app.save_window_state(geometry_flags()) {
                    eprintln!("Failed to save window geometry: {error}");
                }
            },
        ))))
    }
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            if let Some(saver) = window.try_state::<GeometrySaver>() {
                (lock_recover(&saver.0))();
            }
        }
        tauri::WindowEvent::Focused(true) => {
            let label = window.label();
            if is_viewer_label(label) {
                let state = window.state::<AppState>();
                *lock_recover(&state.last_focused_viewer) = Some(label.to_string());
            }
        }
        tauri::WindowEvent::Destroyed => {
            let state = window.state::<WatcherState>();
            lock_recover(&state.watchers).remove(window.label());
            window
                .state::<crate::folder::FolderWatcherState>()
                .forget_window(window.label());
            let app_state = window.state::<AppState>();
            lock_recover(&app_state.window_registry).remove(window.label());
            if let Some(closed) = lock_recover(&app_state.quit).as_mut() {
                closed.push(window.label().to_string());
            };
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A private directory to keep the pin file in, so a test never touches the
    /// real `app_config_dir` and two runs cannot collide.
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("markpad-{tag}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unsaved_changes_are_kept_only_by_the_last_window_or_on_quit() {
        assert!(keeps_unsaved_on_close_for(false, "main", ["main"]));
        assert!(keeps_unsaved_on_close_for(
            false,
            "window-2",
            ["window-2", "settings"]
        ));
        assert!(!keeps_unsaved_on_close_for(
            false,
            "main",
            ["main", "window-2"]
        ));
        assert!(!keeps_unsaved_on_close_for(
            false,
            "window-2",
            ["main", "window-2"]
        ));
        assert!(keeps_unsaved_on_close_for(
            true,
            "main",
            ["main", "window-2"]
        ));
    }

    #[test]
    fn recovery_paths_accept_only_safe_window_labels() {
        let dir = Path::new("unsaved-recovery");
        for label in ["main", "window-123", "A_b-09"] {
            assert_eq!(
                label_file(dir, label).unwrap(),
                dir.join(format!("{label}.json"))
            );
        }
        for label in [
            "", ".", "..", "../main", "a/b", "a\\b", "/main", "a.json", "a b", "é",
        ] {
            assert!(label_file(dir, label).is_err(), "accepted {label:?}");
        }
    }

    #[test]
    fn recovery_snapshots_are_separate_and_empty_save_removes_only_its_window() {
        let root = temp_dir("recovery");
        let dir = root.join("unsaved-recovery");
        assert!(load_unsaved_recovery_at(&dir).unwrap().is_empty());
        save_unsaved_recovery_at(&dir, "main", "[]").unwrap();
        assert!(!dir.exists());
        save_unsaved_recovery_at(&dir, "main", r#"[{"content":"draft"}]"#).unwrap();
        save_unsaved_recovery_at(&dir, "window-2", r#"[{"content":"other"}]"#).unwrap();
        save_unsaved_recovery_at(&dir, "main", r#"[{"content":"updated"}]"#).unwrap();
        assert_eq!(
            load_unsaved_recovery_at(&dir).unwrap(),
            vec![
                ("main".to_string(), r#"[{"content":"updated"}]"#.to_string()),
                (
                    "window-2".to_string(),
                    r#"[{"content":"other"}]"#.to_string()
                ),
            ]
        );
        save_unsaved_recovery_at(&dir, "main", " [] \n").unwrap();
        assert_eq!(load_unsaved_recovery_at(&dir).unwrap().len(), 1);
        clear_unsaved_recovery_at(&dir, &["window-2".into(), "missing".into()]).unwrap();
        assert!(load_unsaved_recovery_at(&dir).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_clear_validates_all_labels_before_removing_anything() {
        let dir = temp_dir("recovery-validation");
        save_unsaved_recovery_at(&dir, "main", "[1]").unwrap();
        assert!(clear_unsaved_recovery_at(&dir, &["main".into(), "../outside".into()]).is_err());
        assert_eq!(fs::read_to_string(dir.join("main.json")).unwrap(), "[1]");
        assert!(save_unsaved_recovery_at(&dir, "../outside", "[2]").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recovery_load_ignores_invalid_names_and_returns_unreadable_files_empty() {
        let dir = temp_dir("recovery-read");
        fs::write(dir.join("bad.name.json"), "ignored").unwrap();
        fs::write(dir.join(".json"), "ignored").unwrap();
        fs::write(dir.join("main.tmp"), "ignored").unwrap();
        fs::create_dir(dir.join("directory.json")).unwrap();
        assert!(load_unsaved_recovery_at(&dir).unwrap().is_empty());
        fs::write(dir.join("main.json"), [0xff]).unwrap();
        fs::write(dir.join("window-2.json"), "[1]").unwrap();
        assert_eq!(
            load_unsaved_recovery_at(&dir).unwrap(),
            vec![
                ("main".to_string(), String::new()),
                ("window-2".to_string(), "[1]".to_string()),
            ]
        );
        assert_eq!(fs::read(dir.join("main.json")).unwrap(), [0xff]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn recovery_does_not_follow_a_snapshot_symlink_into_a_document() {
        let dir = temp_dir("recovery-symlink");
        let document = dir.join("original.md");
        fs::write(&document, "original").unwrap();
        std::os::unix::fs::symlink(&document, dir.join("main.json")).unwrap();
        assert!(save_unsaved_recovery_at(&dir, "main", "[1]").is_err());
        assert!(load_unsaved_recovery_at(&dir).unwrap().is_empty());
        clear_unsaved_recovery_at(&dir, &["main".into()]).unwrap();
        assert_eq!(fs::read_to_string(document).unwrap(), "original");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn main_keeps_its_old_files_and_other_windows_get_one_each() {
        let config = Path::new("config");
        assert_eq!(
            window_state_path_in(config, "main").unwrap(),
            config.join("window-state-v2.json")
        );
        assert_eq!(
            restore_progress_path_in(config, "main").unwrap(),
            config.join("restore-progress-v1.json")
        );
        assert_eq!(
            window_state_path_in(config, "window-ab12").unwrap(),
            config.join("window-state").join("window-ab12.json")
        );
        assert_eq!(
            restore_progress_path_in(config, "window-ab12").unwrap(),
            config.join("restore-progress").join("window-ab12.json")
        );
        for label in ["settings", "", "window-../main", "window-a/b", "window-a.b"] {
            assert!(
                window_state_path_in(config, label).is_err(),
                "accepted {label:?}"
            );
            assert!(
                restore_progress_path_in(config, label).is_err(),
                "accepted {label:?}"
            );
        }
    }

    #[test]
    fn each_window_reads_and_forgets_only_its_own_snapshot() {
        let config = temp_dir("window-state");
        // A session written before snapshots were per window is main's entry.
        fs::write(config.join("window-state-v2.json"), "legacy").unwrap();
        assert_eq!(
            load_window_state_in(&config, "main").as_deref(),
            Some("legacy")
        );
        assert!(remembered_window_labels_in(&config).is_empty());

        save_window_state_in(&config, "main", "m").unwrap();
        save_window_state_in(&config, "window-b", "b").unwrap();
        save_window_state_in(&config, "window-a", "a").unwrap();
        write_restore_progress(
            &restore_progress_path_in(&config, "window-a").unwrap(),
            "{}",
        )
        .unwrap();
        assert!(save_window_state_in(&config, "settings", "x").is_err());
        fs::write(config.join("window-state").join("notes.json"), "x").unwrap();
        assert_eq!(load_window_state_in(&config, "main").as_deref(), Some("m"));
        assert_eq!(
            load_window_state_in(&config, "window-a").as_deref(),
            Some("a")
        );
        assert_eq!(load_window_state_in(&config, "window-c"), None);
        assert_eq!(
            remembered_window_labels_in(&config),
            ["window-a", "window-b"]
        );

        forget_window_state_in(&config, "window-a").unwrap();
        assert_eq!(remembered_window_labels_in(&config), ["window-b"]);
        assert!(!config
            .join("restore-progress")
            .join("window-a.json")
            .exists());
        assert_eq!(load_window_state_in(&config, "main").as_deref(), Some("m"));
        forget_window_state_in(&config, "main").unwrap();
        assert_eq!(load_window_state_in(&config, "main"), None);
        assert_eq!(
            load_window_state_in(&config, "window-b").as_deref(),
            Some("b")
        );

        save_window_state_in(&config, "main", "m").unwrap();
        clear_window_state_in(&config).unwrap();
        assert_eq!(load_window_state_in(&config, "main"), None);
        assert!(remembered_window_labels_in(&config).is_empty());
        clear_window_state_in(&config).unwrap();
        fs::remove_dir_all(config).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_window_snapshot_does_not_follow_a_symlink_into_a_document() {
        let config = temp_dir("window-state-symlink");
        let document = config.join("original.md");
        fs::write(&document, "original").unwrap();
        fs::create_dir(config.join("window-state")).unwrap();
        std::os::unix::fs::symlink(&document, config.join("window-state").join("window-a.json"))
            .unwrap();
        assert!(save_window_state_in(&config, "window-a", "x").is_err());
        assert!(remembered_window_labels_in(&config).is_empty());
        assert_eq!(fs::read_to_string(document).unwrap(), "original");
        fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn a_cancelled_quit_forgets_the_windows_it_closed() {
        let config = temp_dir("quit");
        let quit = Mutex::new(None);
        save_window_state_in(&config, "window-a", "a").unwrap();
        save_window_state_in(&config, "window-b", "b").unwrap();
        // A close cancelled with no quit under way forgets nothing.
        assert!(update_quit(&quit, false).is_empty());

        update_quit(&quit, true);
        lock_recover(&quit)
            .as_mut()
            .unwrap()
            .push("window-a".to_string());
        // A second Quit while the first is still closing keeps the record.
        update_quit(&quit, true);
        let closed = update_quit(&quit, false);
        assert_eq!(closed, ["window-a"]);
        for label in &closed {
            forget_window_state_in(&config, label).unwrap();
        }
        assert_eq!(remembered_window_labels_in(&config), ["window-b"]);
        assert!(lock_recover(&quit).is_none());
        fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn an_orphan_backup_is_handed_out_once() {
        let records = || {
            vec![
                ("main".to_string(), "m".to_string()),
                ("window-crashed".to_string(), "c".to_string()),
                ("window-open".to_string(), "o".to_string()),
            ]
        };
        let orphan = |label: &str| label == "window-crashed";
        let labels = |taken: Vec<(String, String)>| -> Vec<String> {
            taken.into_iter().map(|(label, _)| label).collect()
        };
        let mut claimed = HashSet::new();
        assert_eq!(
            labels(claim_recovery_records(
                records(),
                "window-open",
                orphan,
                &mut claimed
            )),
            ["window-crashed", "window-open"]
        );
        assert_eq!(
            labels(claim_recovery_records(
                records(),
                "main",
                orphan,
                &mut claimed
            )),
            ["main"]
        );
    }

    #[test]
    fn the_launch_window_adopts_a_remembered_window_only_without_a_snapshot() {
        let remembered = ["window-a".to_string(), "window-b".to_string()];
        assert_eq!(adoption_source(true, &remembered), None);
        assert_eq!(adoption_source(false, &remembered), Some("window-a"));
        assert_eq!(adoption_source(false, &[]), None);
    }

    #[test]
    fn adoption_moves_every_file_of_the_window_to_the_launch_window() {
        let config = temp_dir("adopt");
        let recovery = config.join(UNSAVED_RECOVERY_DIR);
        save_window_state_in(&config, "window-a", "a").unwrap();
        write_restore_progress(&restore_progress_path_in(&config, "window-a").unwrap(), "p")
            .unwrap();
        save_unsaved_recovery_at(&recovery, "window-a", "[1]").unwrap();
        let geometry = config.join(tauri_plugin_window_state::DEFAULT_FILENAME);
        fs::write(&geometry, r#"{"main":{"x":1},"window-a":{"x":2}}"#).unwrap();

        adopt_window_in(&config, "window-a").unwrap();

        assert_eq!(
            load_window_state_in(&config, LAUNCH_LABEL).as_deref(),
            Some("a")
        );
        assert!(remembered_window_labels_in(&config).is_empty());
        assert_eq!(
            fs::read_to_string(restore_progress_path_in(&config, LAUNCH_LABEL).unwrap()).unwrap(),
            "p"
        );
        assert_eq!(
            load_unsaved_recovery_at(&recovery).unwrap(),
            [("main".to_string(), "[1]".to_string())]
        );
        let entries: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&geometry).unwrap()).unwrap();
        assert_eq!(entries, serde_json::json!({"main": {"x": 2}}));
        fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn adoption_never_overwrites_the_launch_windows_own_backup() {
        let config = temp_dir("adopt-backup");
        let recovery = config.join(UNSAVED_RECOVERY_DIR);
        save_window_state_in(&config, "window-a", "a").unwrap();
        save_unsaved_recovery_at(&recovery, "main", "[0]").unwrap();
        save_unsaved_recovery_at(&recovery, "window-a", "[1]").unwrap();

        adopt_window_in(&config, "window-a").unwrap();

        // window-a's backup now has no snapshot: an orphan, claimed at startup.
        assert_eq!(
            load_unsaved_recovery_at(&recovery).unwrap(),
            [
                ("main".to_string(), "[0]".to_string()),
                ("window-a".to_string(), "[1]".to_string()),
            ]
        );
        assert_eq!(
            load_window_state_in(&config, LAUNCH_LABEL).as_deref(),
            Some("a")
        );
        fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn a_file_opened_while_running_goes_to_the_last_focused_window() {
        let open = ["main", "window-a", "window-b"];
        assert_eq!(
            delivery_label(Some("window-b"), Some("window-a"), &open),
            Some("window-b")
        );
        assert_eq!(
            delivery_label(None, Some("window-a"), &open),
            Some("window-a")
        );
        // The last focused window has closed since.
        assert_eq!(delivery_label(None, Some("window-c"), &open), Some("main"));
        assert_eq!(
            delivery_label(None, None, &["window-b", "window-a"]),
            Some("window-b")
        );
        assert_eq!(delivery_label(None, None, &[]), None);
    }

    /// argv, as the shell would hand it over: `argv[0]` and then the arguments.
    fn argv(args: &[&str]) -> Vec<String> {
        std::iter::once("markpad")
            .chain(args.iter().copied())
            .map(String::from)
            .collect()
    }

    /// Nothing that names a directory may reach the frontend as a document.
    ///
    /// A tab whose path is a directory cannot be read and cannot be saved, and
    /// it is not disposable either: it HAS a path, so the session serialiser
    /// keeps it and every later launch restores it and fails again.
    ///
    /// The trailing-separator cases are the ones the existence check alone does
    /// not answer: `gone/` names no directory that exists, but it still cannot
    /// name a file. Without that guard the last two entries come back.
    #[test]
    fn an_argument_naming_a_directory_is_never_offered_as_a_document() {
        let dir = temp_dir("argv-directory");
        let sep = std::path::MAIN_SEPARATOR;
        let with_sep = format!("{}{}", dir.display(), sep);
        let missing_with_sep = format!("{}{}", dir.join("gone").display(), sep);

        let args = argv(&[
            &dir.display().to_string(),
            &with_sep,
            ".",
            "",
            &missing_with_sep,
            "notes/",
        ]);

        assert_eq!(startup_paths(&args, &dir), Vec::<String>::new());
    }

    /// A file the user has yet to write is a request, not a mistake: `vim` and
    /// `code` both answer it with an empty buffer at that name, and argv cannot
    /// tell it from a typo. Guards against "validate" being read as "reject
    /// anything that fails `exists()`", which would answer `markpad draft.md`
    /// with an empty window and no explanation.
    ///
    /// The extension is not part of the question either — Markpad's Open dialog
    /// offers "All Files".
    #[test]
    fn a_file_that_does_not_exist_yet_is_still_offered() {
        let dir = temp_dir("argv-missing");
        let existing = dir.join("kept.png");
        fs::write(&existing, b"not markdown").unwrap();
        let missing = dir.join("draft.md");

        let args = argv(&[
            &missing.display().to_string(),
            &existing.display().to_string(),
        ]);

        assert_eq!(
            startup_paths(&args, &dir),
            vec![
                missing.display().to_string(),
                existing.display().to_string()
            ]
        );
    }

    /// Relative arguments are resolved once, here, rather than by whichever
    /// directory the reader happens to be in. The resolved string is what the
    /// tab, the recent-files list and the watcher all keep.
    #[test]
    fn a_relative_argument_is_resolved_against_the_launch_directory() {
        let dir = temp_dir("argv-relative");
        let file = dir.join("notes.md");
        fs::write(&file, b"# notes").unwrap();

        let args = argv(&["-f", "notes.md"]);

        assert_eq!(startup_paths(&args, &dir), vec![file.display().to_string()]);
    }

    fn names(tags: &[PinnedTag]) -> HashSet<String> {
        tags.iter().map(|tag| tag.name.clone()).collect()
    }

    /// Every concurrent edit has to survive.
    ///
    /// Deliberately asserts the PROPERTY — the final file contains exactly the
    /// tags the writers between them asked for — rather than any mechanism. A
    /// test that watched for a particular interleaving, or for a specific error,
    /// would pass on whichever platform happens not to produce it; the set of
    /// surviving names is the thing the user actually loses when this breaks,
    /// and it is checked identically everywhere.
    ///
    /// Without the lock in `update_pinned_tags` this fails on every run: writers
    /// read the same list and each writes back a full copy, so most of the
    /// `keep-*` additions are overwritten and most of the `doomed-*` removals
    /// come back from under a stale snapshot. Measured on master's shape, 1-4
    /// of 8 pins survived and 3-7 of 8 unpins were resurrected.
    #[test]
    fn concurrent_edits_do_not_overwrite_one_another() {
        const WRITERS: usize = 8;
        const ROUNDS: usize = 4;

        let dir = temp_dir("pinned-tags-race");
        let path = dir.join("pinned-tags.json");
        let lock = Mutex::new(());

        // Seed the file with the tags the removers will delete, plus bystanders
        // nobody touches. The bystanders are a control: they are in every
        // writer's snapshot, so a lost update does NOT drop them, and they stay
        // green either way. If they ever go missing the file was truncated or
        // clobbered outright, which is a different failure from this one.
        let seeded: Vec<PinnedTag> = (0..WRITERS)
            .flat_map(|writer| {
                [
                    PinnedTag {
                        name: format!("doomed-{writer}"),
                        color: "#000000".to_string(),
                        files: vec![],
                    },
                    PinnedTag {
                        name: format!("bystander-{writer}"),
                        color: "#111111".to_string(),
                        files: vec![],
                    },
                ]
            })
            .collect();
        fs::write(&path, serde_json::to_string(&seeded).unwrap()).unwrap();

        std::thread::scope(|scope| {
            for writer in 0..WRITERS {
                let path = path.as_path();
                let lock = &lock;
                scope.spawn(move || {
                    for round in 0..ROUNDS {
                        save_pinned_tag_at(
                            lock,
                            path,
                            format!("keep-{writer}"),
                            "#222222".to_string(),
                            vec![format!("/tmp/{writer}-{round}.md")],
                            true,
                        )
                        .unwrap();
                    }
                });
                scope.spawn(move || {
                    for _ in 0..ROUNDS {
                        remove_pinned_tag_at(lock, path, format!("doomed-{writer}")).unwrap();
                    }
                });
            }
        });

        let survivors = read_pinned_tags_at(&path);
        let found = names(&survivors);

        let expected: HashSet<String> = (0..WRITERS)
            .flat_map(|writer| [format!("keep-{writer}"), format!("bystander-{writer}")])
            .collect();
        assert_eq!(
            found, expected,
            "every pin written concurrently must survive and every unpin must stick"
        );
        // One entry per name: a writer that re-ran its own save must have found
        // its earlier entry rather than appending a duplicate.
        assert_eq!(survivors.len(), expected.len());

        fs::remove_dir_all(&dir).unwrap();
    }

    /// Re-pinning a tag replaces its color and file list in place.
    #[test]
    fn saving_an_existing_tag_updates_it_rather_than_duplicating_it() {
        let dir = temp_dir("pinned-tags-update");
        let path = dir.join("pinned-tags.json");
        let lock = Mutex::new(());

        save_pinned_tag_at(
            &lock,
            &path,
            "work".to_string(),
            "#1a73e8".to_string(),
            vec!["/tmp/a.md".to_string()],
            true,
        )
        .unwrap();
        save_pinned_tag_at(
            &lock,
            &path,
            "work".to_string(),
            "#d93025".to_string(),
            vec!["/tmp/b.md".to_string()],
            true,
        )
        .unwrap();

        let tags = read_pinned_tags_at(&path);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].color, "#d93025");
        assert_eq!(tags[0].files, vec!["/tmp/b.md".to_string()]);

        remove_pinned_tag_at(&lock, &path, "work".to_string()).unwrap();
        assert!(read_pinned_tags_at(&path).is_empty());

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A window's closing save only refreshes a pin that still exists. Another
    /// window may have unpinned the tag while this one still held it, and
    /// writing it back then would undo that unpin.
    #[test]
    fn updating_a_pin_never_recreates_one_that_was_removed() {
        let dir = temp_dir("pinned-tags-update-only");
        let path = dir.join("pinned-tags.json");
        let lock = Mutex::new(());

        save_pinned_tag_at(
            &lock,
            &path,
            "Research".to_string(),
            "#1a73e8".to_string(),
            vec!["/papers/a.md".to_string()],
            true,
        )
        .unwrap();
        let updated = save_pinned_tag_at(
            &lock,
            &path,
            "Research".to_string(),
            "#d93025".to_string(),
            vec!["/papers/b.md".to_string()],
            false,
        )
        .unwrap();
        assert!(updated);
        let tags = read_pinned_tags_at(&path);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].color, "#d93025");
        assert_eq!(tags[0].files, vec!["/papers/b.md".to_string()]);

        remove_pinned_tag_at(&lock, &path, "Research".to_string()).unwrap();
        let updated = save_pinned_tag_at(
            &lock,
            &path,
            "Research".to_string(),
            "#d93025".to_string(),
            vec!["/papers/b.md".to_string()],
            false,
        )
        .unwrap();
        assert!(!updated, "the update reported a pin that is gone");
        assert!(read_pinned_tags_at(&path).is_empty());

        fs::remove_dir_all(&dir).unwrap();
    }

    /// Renaming a pinned tag renames its entry, so the closing save — which
    /// finds the entry by the window's current name — still finds it.
    #[test]
    fn renaming_a_pin_keeps_its_files_under_the_new_name() {
        let dir = temp_dir("pinned-tags-rename");
        let path = dir.join("pinned-tags.json");
        let lock = Mutex::new(());

        save_pinned_tag_at(
            &lock,
            &path,
            "Research".to_string(),
            "#1a73e8".to_string(),
            vec!["/papers/a.md".to_string()],
            true,
        )
        .unwrap();
        let outcome = rename_pinned_tag_at(
            &lock,
            &path,
            "Research".to_string(),
            "Papers".to_string(),
            "#d93025".to_string(),
        )
        .unwrap();
        assert_eq!(outcome, PinnedTagRename::Renamed);
        let tags = read_pinned_tags_at(&path);
        assert_eq!(tags.len(), 1, "the rename left the old entry behind");
        assert_eq!(tags[0].name, "Papers");
        assert_eq!(tags[0].color, "#d93025");
        assert_eq!(tags[0].files, vec!["/papers/a.md".to_string()]);

        let updated = save_pinned_tag_at(
            &lock,
            &path,
            "Papers".to_string(),
            "#d93025".to_string(),
            vec!["/papers/b.md".to_string()],
            false,
        )
        .unwrap();
        assert!(updated, "the closing save did not find the renamed pin");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A name another pin holds is refused, and a pin another window removed
    /// is not recreated by renaming it.
    #[test]
    fn renaming_a_pin_refuses_a_taken_name_and_never_recreates_one() {
        let dir = temp_dir("pinned-tags-rename-refused");
        let path = dir.join("pinned-tags.json");
        let lock = Mutex::new(());

        for (name, file) in [("Research", "/papers/a.md"), ("Notes", "/notes/c.md")] {
            save_pinned_tag_at(
                &lock,
                &path,
                name.to_string(),
                "#1a73e8".to_string(),
                vec![file.to_string()],
                true,
            )
            .unwrap();
        }
        let outcome = rename_pinned_tag_at(
            &lock,
            &path,
            "Research".to_string(),
            "Notes".to_string(),
            "#d93025".to_string(),
        )
        .unwrap();
        assert_eq!(outcome, PinnedTagRename::Taken);
        let tags = read_pinned_tags_at(&path);
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].name, "Research");
        assert_eq!(tags[1].files, vec!["/notes/c.md".to_string()]);

        let outcome = rename_pinned_tag_at(
            &lock,
            &path,
            "Gone".to_string(),
            "Back".to_string(),
            "#d93025".to_string(),
        )
        .unwrap();
        assert_eq!(outcome, PinnedTagRename::Missing);
        assert_eq!(read_pinned_tags_at(&path).len(), 2);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// The loss that makes tag names exclusive worth enforcing.
    ///
    /// Two windows, one tag name, one pinned document set. Both windows pin —
    /// serially, each holding the lock in turn, so #424's `pinned_tags` mutex
    /// is doing its job and this is not a race. `save_pinned_tag_at` still
    /// finds the entry BY NAME and replaces its whole `files` list, so the
    /// second window's pin does not merge with the first's, it erases it. The
    /// user set two windows up and gets one back.
    ///
    /// Asserted on the surviving file rather than on the call, because the call
    /// succeeds in both worlds: `save_pinned_tag` returns `Ok(())` either
    /// way and nothing anywhere reports the overwrite.
    #[test]
    fn two_windows_sharing_a_tag_name_overwrite_one_anothers_pinned_files() {
        let dir = temp_dir("pinned-tags-shared-name");
        let path = dir.join("pinned-tags.json");
        let lock = Mutex::new(());

        save_pinned_tag_at(
            &lock,
            &path,
            "Research".to_string(),
            "#1a73e8".to_string(),
            vec!["/papers/a.md".to_string(), "/papers/b.md".to_string()],
            true,
        )
        .unwrap();
        save_pinned_tag_at(
            &lock,
            &path,
            "Research".to_string(),
            "#d93025".to_string(),
            vec!["/notes/c.md".to_string()],
            true,
        )
        .unwrap();

        let tags = read_pinned_tags_at(&path);
        assert_eq!(
            tags.len(),
            1,
            "one name, one entry — the pin file is keyed by name"
        );
        assert_eq!(
            tags[0].files,
            vec!["/notes/c.md".to_string()],
            "the second window replaced the first window's document set rather than adding to it"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    fn meta_with_tag(tag: Option<&str>) -> WindowMeta {
        WindowMeta {
            number: 1,
            tag_name: tag.map(str::to_string),
            tag_color: tag.map(|_| "#1a73e8".to_string()),
            active_tab_title: String::new(),
            tab_count: 0,
        }
    }

    /// A name is taken by OTHER windows only — never by the asker itself.
    #[test]
    fn a_window_never_blocks_its_own_tag_name() {
        let mut registry = HashMap::new();
        registry.insert("main".to_string(), meta_with_tag(Some("Research")));

        assert!(
            !tag_held_by_another_window(&registry, "main", "Research"),
            "renaming the colour of a tag a window already holds must not be refused"
        );
        assert!(
            tag_held_by_another_window(&registry, "window-2", "Research"),
            "a second window taking the same name must be seen"
        );
    }

    /// Only an exact, currently-held name is taken.
    #[test]
    fn only_a_live_windows_exact_tag_name_is_taken() {
        let mut registry = HashMap::new();
        registry.insert("main".to_string(), meta_with_tag(Some("Research")));
        registry.insert("window-2".to_string(), meta_with_tag(None));

        assert!(!tag_held_by_another_window(
            &registry, "window-3", "research"
        ));
        assert!(!tag_held_by_another_window(
            &registry,
            "window-3",
            "Research notes"
        ));
        assert!(!tag_held_by_another_window(&registry, "window-3", ""));

        // The registry is the live window list, so a closed window releases its
        // name with no bookkeeping of its own — this is what `Destroyed` does.
        registry.remove("main");
        assert!(
            !tag_held_by_another_window(&registry, "window-3", "Research"),
            "a name held by a window that has closed must be free again"
        );
    }

    /// A poisoned lock must not disable pinning for the rest of the session.
    #[test]
    fn a_panicking_writer_does_not_lock_out_the_next_one() {
        let dir = temp_dir("pinned-tags-poison");
        let path = dir.join("pinned-tags.json");
        let lock = Mutex::new(());

        let panicked = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    update_pinned_tags(&lock, &path, |_| panic!("edit blew up")).unwrap();
                })
                .join()
        });
        assert!(panicked.is_err());
        assert!(lock.is_poisoned());

        // The panic happened before `atomic_write`, so nothing was published;
        // the next writer must both acquire the lock and see an intact file.
        save_pinned_tag_at(
            &lock,
            &path,
            "after".to_string(),
            "#188038".to_string(),
            vec![],
            true,
        )
        .unwrap();
        let tags = read_pinned_tags_at(&path);
        assert_eq!(names(&tags), HashSet::from(["after".to_string()]));

        fs::remove_dir_all(&dir).unwrap();
    }

    /// The breadcrumb must never be readable half-written.
    ///
    /// Its two failure directions are not symmetric. A stale record costs one
    /// spurious deferral: a document the user can reopen by hand. An empty or
    /// truncated one parses as "no interruption", so the next launch walks
    /// back into whatever killed the last one — the failure the record exists
    /// to prevent. `fs::write` truncates before it writes, which puts an empty
    /// file on disk for as long as the write takes, so the write goes through
    /// a temp file and a rename instead.
    ///
    /// Asserts the property a reader can observe rather than the mechanism:
    /// every read either fails (no file yet) or yields one of the payloads the
    /// writer actually wrote, whole.
    #[test]
    fn a_reader_never_sees_a_half_written_breadcrumb() {
        use std::sync::atomic::{AtomicBool, AtomicUsize};

        let dir = temp_dir("restore-progress-torn");
        let path = dir.join("restore-progress-v1.json");

        // Long enough that a truncating writer is observable. A hundred bytes
        // might reach the file in one step on some filesystems and make this
        // test lie; eight kilobytes will not.
        let payloads: Vec<String> = (0..4u8)
            .map(|i| {
                let pending = format!("/{}{}.md", (b'a' + i) as char, "x".repeat(8192));
                format!("{{\"running\":true,\"pending\":\"{pending}\",\"deferred\":[],\"interruptions\":0}}")
            })
            .collect();

        let writing = AtomicBool::new(true);
        let whole_reads = AtomicUsize::new(0);

        std::thread::scope(|scope| {
            scope.spawn(|| {
                for round in 0..300 {
                    write_restore_progress(&path, &payloads[round % payloads.len()]).unwrap();
                }
                writing.store(false, Ordering::Relaxed);
            });
            scope.spawn(|| {
                while writing.load(Ordering::Relaxed) {
                    // A failed read is the file not existing yet, which is the
                    // one state startup already handles correctly.
                    if let Ok(text) = fs::read_to_string(&path) {
                        assert!(
                            payloads.contains(&text),
                            "a launch read a breadcrumb of {} bytes that is not any record the writer wrote; \
                             startup would parse it as 'nothing was interrupted'",
                            text.len()
                        );
                        whole_reads.fetch_add(1, Ordering::Relaxed);
                    }
                }
            });
        });

        // Without this the assertion above is vacuous: a reader that never
        // managed to open the file would sail through having checked nothing.
        assert!(
            whole_reads.load(Ordering::Relaxed) > 0,
            "the reader never read the breadcrumb at all, so it proved nothing"
        );

        // The temp file is an implementation detail of the write and must not
        // outlive it, or app_config_dir fills up one launch at a time.
        let left_behind: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != "restore-progress-v1.json")
            .collect();
        assert_eq!(left_behind, Vec::<String>::new());

        fs::remove_dir_all(&dir).unwrap();
    }
}

/// Does a watch armed on a FILE survive that file being replaced by a rename?
///
/// Not a test of Markpad's code — a test of the platform behaviour `watch_file`
/// rests on, which is the only way to know whether the assumption holds on the
/// three targets. `atomic_write` saves every document by writing a temp file
/// alongside and renaming it over the target, so this is not an exotic case:
/// it is what one Markpad save does to its own watch, and what most editors do
/// to it (VS Code, Vim, JetBrains, Emacs all rename on save).
///
/// If this fails on a platform, the watcher there stops reporting anything
/// after the first save, silently and for the rest of the session.
#[cfg(test)]
mod watch_targeting {
    use super::{event_concerns, watch_root};
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    fn event(paths: &[&str]) -> notify::Event {
        let mut e = notify::Event::new(notify::EventKind::Any);
        e.paths = paths.iter().map(PathBuf::from).collect();
        e
    }

    #[test]
    fn a_watch_is_armed_on_the_containing_directory() {
        assert_eq!(
            watch_root(Path::new("/notes/a.md")),
            PathBuf::from("/notes")
        );
        // No usable parent: the file itself, which is what it always was.
        assert_eq!(watch_root(Path::new("a.md")), PathBuf::from("a.md"));
        assert_eq!(watch_root(Path::new("/")), PathBuf::from("/"));
    }

    #[test]
    fn only_events_naming_the_watched_file_get_through() {
        let name = Some(OsStr::new("a.md"));
        assert!(event_concerns(&event(&["/notes/a.md"]), name));
        // A rename reports both sides; ours being either one is our business.
        assert!(event_concerns(
            &event(&["/notes/a.md.tmp99", "/notes/a.md"]),
            name
        ));
        // The directory reports its other entries, and the temp file every
        // `atomic_write` leaves beside the target is one of them.
        assert!(!event_concerns(&event(&["/notes/b.md"]), name));
        assert!(!event_concerns(&event(&["/notes/a.md.tmp99"]), name));
        assert!(!event_concerns(&event(&[]), name));
        // The fallback watch is on the file, so there is nothing to filter.
        assert!(event_concerns(&event(&["/notes/b.md"]), None));
    }
}

#[cfg(test)]
mod coalesced_calls {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn a_burst_runs_once_after_it_and_a_later_call_runs_again() {
        let runs = Arc::new(AtomicUsize::new(0));
        let counter = runs.clone();
        let call = super::coalesced(Duration::from_millis(100), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });

        // Temp write, rename, metadata: one save.
        for _ in 0..5 {
            call();
        }
        assert_eq!(
            runs.load(Ordering::SeqCst),
            0,
            "ran before the burst settled"
        );
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(runs.load(Ordering::SeqCst), 1, "one save, one reload");

        // The next save is its own change, not swallowed by the last one.
        call();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }
}

#[cfg(test)]
mod watch_survives_rename {
    use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
    use std::sync::mpsc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn a_file_watch_still_reports_after_the_file_is_replaced() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("markpad-watch-{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("notes.md");
        std::fs::write(&target, b"one").unwrap();

        let name = target.file_name().map(std::ffi::OsStr::to_os_string);
        let (tx, rx) = mpsc::channel();
        let mut watcher = RecommendedWatcher::new(
            move |result: Result<notify::Event, notify::Error>| {
                // The same two decisions `watch_file` makes, so this exercises
                // the composition rather than notify on its own.
                let Ok(event) = result else { return };
                if !super::event_concerns(&event, name.as_deref()) {
                    return;
                }
                // The names, not a bare tick. Which file an event was about is
                // the only timing-independent way to ask whether the filter
                // held: an event is allowed to arrive late, but it is never
                // allowed to name somebody else's file.
                let names: Vec<String> = event
                    .paths
                    .iter()
                    .filter_map(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                    .collect();
                let _ = tx.send(names);
            },
            Config::default(),
        )
        .unwrap();
        // Exactly what `watch_file` arms.
        watcher
            .watch(&super::watch_root(&target), RecursiveMode::NonRecursive)
            .unwrap();

        let mut delivered: Vec<Vec<String>> = Vec::new();
        let collect = |rx: &mpsc::Receiver<Vec<String>>, out: &mut Vec<Vec<String>>| {
            let first = rx.recv_timeout(Duration::from_secs(5)).ok();
            let reported = first.is_some();
            out.extend(first);
            while let Ok(more) = rx.try_recv() {
                out.push(more);
            }
            reported
        };

        // First write in place, to prove the watch is live at all. Without this
        // a dead watcher and a broken harness look identical.
        std::fs::write(&target, b"two").unwrap();
        let alive = collect(&rx, &mut delivered);

        // Now the way `atomic_write` — and every editor that saves atomically —
        // actually writes: a new file renamed over the old one.
        let temp = dir.join("notes.md.tmp1234");
        std::fs::write(&temp, b"three").unwrap();
        std::fs::rename(&temp, &target).unwrap();
        let replaced = collect(&rx, &mut delivered);

        // The write that used to be invisible: the inode the watch was armed on
        // is gone, and this one belongs to the file that replaced it.
        std::fs::write(&target, b"four").unwrap();
        let after = collect(&rx, &mut delivered);

        // The watch covers the whole directory now, so the filter is the only
        // thing keeping the neighbours out — including the temp file
        // `atomic_write` drops beside every save.
        std::fs::write(dir.join("unrelated.md"), b"not ours").unwrap();
        std::fs::write(dir.join("notes.md.tmp5678"), b"nor this").unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        while let Ok(more) = rx.try_recv() {
            delivered.push(more);
        }

        std::fs::remove_dir_all(&dir).ok();
        assert!(
            alive,
            "the watch reported nothing even for an in-place write"
        );
        assert!(replaced, "the rename itself was not reported");
        assert!(
            after,
            "the watch died with the replaced inode: every later external change is invisible",
        );
        // Asserted over every event the run produced rather than over a quiet
        // window, because a late event about the watched file is legitimate and
        // a slow machine will produce one. What must never appear is a
        // neighbour's name.
        for names in &delivered {
            assert!(
                names.iter().any(|n| n == "notes.md"),
                "an event about {names:?} was reported as a change to notes.md",
            );
        }
    }
}
