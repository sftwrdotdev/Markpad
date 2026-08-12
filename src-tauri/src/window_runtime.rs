use crate::fs_safety::atomic_write;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
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

pub struct AppState {
    pub(crate) startup_files: Mutex<Vec<String>>,
    pub(crate) last_focused_viewer: Mutex<Option<String>>,
    window_registry: Mutex<HashMap<String, WindowMeta>>,
    window_counter: AtomicU64,
    /// Serialises the read-modify-write cycle over `pinned-tags.json`. Guards
    /// a critical section rather than a value, so the payload is `()` — see
    /// `update_pinned_tags` for why the whole cycle has to be inside it.
    pinned_tags: Mutex<()>,
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
            startup_files: Mutex::new(Vec::new()),
            last_focused_viewer: Mutex::new(None),
            window_registry: Mutex::new(HashMap::new()),
            window_counter: AtomicU64::new(0),
            pinned_tags: Mutex::new(()),
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

fn pinned_tags_path(app: &AppHandle) -> Result<std::path::PathBuf, crate::error::Error> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("pinned-tags.json"))
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
/// Tauri dispatches commands on a thread pool and every window can call these,
/// so the interleaving is reachable whenever two windows persist their pins at
/// once — which is exactly what quitting with ⌘Q does, since each window saves
/// its pinned tag from its own close handler.
///
/// This is the same defect the frontend fixed in #405 for the recent-files
/// list, where a re-read alone was enough. The previous revision of this
/// comment — written here, by #424, the change that added this lock —
/// explained why by saying that `localStorage` is per-document and
/// single-threaded,
/// "making an RMW cycle atomic by construction". That is false, and it is
/// corrected here rather than softened, because someone reasoning from it
/// about some other shared `localStorage` key would conclude they need no
/// synchronisation at all. Each *document* is single-threaded; two Markpad
/// windows are two documents sharing one origin's storage area. The storage
/// mutex the HTML standard describes for exactly this case is not implemented
/// by any shipping engine, WebKit and WebView2 included, so a `getItem` …
/// `setItem` pair in one window can interleave with the other window's and
/// lose precisely the update drawn above.
///
/// What the re-read buys is a narrower window, not atomicity:
///
/// - Before it, the exposure was the whole lifetime of a window's in-memory
///   copy — from the last time that window looked at the list until it next
///   wrote, which is minutes. After it, the cycle is one synchronous turn of
///   the event loop containing no `await`: `getItem`, a `JSON.parse` of at
///   most nine short strings, `setItem`.
/// - The writes happen on discrete user actions (open a file, remove an
///   entry, rename), so colliding means two windows landing inside those
///   microseconds.
/// - What a collision costs is one entry of a recent-file list, which the
///   next open puts back.
///
/// It is a residual race, accepted on those three grounds — not a guarantee.
/// None of the three holds here. This cycle is a file read, a parse, a
/// serialize and an `atomic_write`: milliseconds of I/O on a preemptively
/// scheduled thread pool, not microseconds of straight-line JS. The collision
/// is not a coincidence but the ordinary shape of quitting, since ⌘Q makes
/// every window write from its own close handler at once. And a dropped pin is
/// a thing the user made, with nothing to recreate it from. Unlocked, this
/// cycle was measured losing updates; hence the lock.
///
/// Serialising also keeps two `atomic_write` calls off the same target at
/// once, which is not something `atomic_write` handles either: its temp file
/// is named from the target name, the pid and a nanosecond clock reading, so
/// two threads of one process that land on the same reading collide on
/// `create_new` — and the loser's cleanup then deletes the temp file the
/// winner was about to rename. Both spellings of that failure showed up in the
/// unlocked measurements (`File exists`, `No such file or directory`).
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

fn save_pinned_tag_at(
    lock: &Mutex<()>,
    path: &Path,
    name: String,
    color: String,
    files: Vec<String>,
) -> Result<(), crate::error::Error> {
    update_pinned_tags(lock, path, move |tags| {
        if let Some(tag) = tags.iter_mut().find(|tag| tag.name == name) {
            tag.color = color;
            tag.files = files;
        } else {
            tags.push(PinnedTag { name, color, files });
        }
    })
}

fn remove_pinned_tag_at(lock: &Mutex<()>, path: &Path, name: String) -> Result<(), crate::error::Error> {
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
    save_pinned_tag_at(&state.pinned_tags, &path, name, color, files).map_err(String::from)
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
    if label != "main" && !label.starts_with("window-") {
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
pub fn is_window_tag_taken(window: tauri::Window, state: State<'_, AppState>, name: String) -> bool {
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

#[tauri::command]
pub async fn show_window(window: tauri::Window) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn window_state_path(app: &AppHandle) -> Result<std::path::PathBuf, crate::error::Error> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("window-state-v2.json"))
}

/// Persists the session snapshot atomically.
///
/// This runs while the last window is closing — the moment the WebKit storage
/// process is already tearing down — so a partial write is a realistic
/// outcome, not a theoretical one. `fs::write` truncates first and then
/// streams, so a crash mid-write leaves behind half a JSON document, and the
/// next launch restores no tabs at all. `atomic_write` publishes the new
/// snapshot with a rename: the file on disk is either entirely the old
/// session or entirely the new one.
#[tauri::command]
pub fn save_window_state(app: AppHandle, json: String) -> Result<(), String> {
    atomic_write(&window_state_path(&app)?, json.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_window_state(app: AppHandle) -> Option<String> {
    fs::read_to_string(window_state_path(&app).ok()?).ok()
}

#[tauri::command]
pub fn clear_window_state(app: AppHandle) -> Result<(), String> {
    let path = window_state_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn restore_progress_path(app: &AppHandle) -> Result<std::path::PathBuf, crate::error::Error> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("restore-progress-v1.json"))
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
    // Two Markpad processes (Windows, Linux) would otherwise share a temp name
    // and the loser would delete the winner's file out from under its rename.
    let temp = path.with_file_name(format!(".restore-progress-{}.tmp", std::process::id()));
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

#[tauri::command]
pub fn save_restore_progress(app: AppHandle, json: String) -> Result<(), String> {
    write_restore_progress(&restore_progress_path(&app)?, &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_restore_progress(app: AppHandle) -> Option<String> {
    fs::read_to_string(restore_progress_path(&app).ok()?).ok()
}

#[tauri::command]
pub fn clear_restore_progress(app: AppHandle) -> Result<(), String> {
    let path = restore_progress_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn bring_to_front(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn pick_delivery_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let viewers: Vec<tauri::WebviewWindow> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label == "main" || label.starts_with("window-"))
        .map(|(_, window)| window)
        .collect();

    if let Some(focused) = viewers
        .iter()
        .find(|window| window.is_focused().unwrap_or(false))
    {
        return Some(focused.clone());
    }

    let state = app.state::<AppState>();
    let last = lock_recover(&state.last_focused_viewer).clone();
    if let Some(label) = last {
        if let Some(window) = viewers.iter().find(|window| window.label() == label) {
            return Some(window.clone());
        }
    }

    viewers.into_iter().next()
}

pub fn handle_single_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    let Some(window) = pick_delivery_window(app) else {
        return;
    };
    let path_str = args
        .iter()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .map(String::as_str)
        .unwrap_or("");
    if !path_str.is_empty() {
        let path = Path::new(path_str);
        let resolved_path = if path.is_absolute() {
            path_str.to_string()
        } else {
            Path::new(&cwd).join(path).display().to_string()
        };
        let _ = app.emit_to(window.label(), "file-path", resolved_path);
    }
    bring_to_front(&window);
}

pub fn create_transfer_window(app: AppHandle, token: String) -> Result<(), String> {
    let label = format!("window-{token}");
    #[allow(unused_mut)]
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
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

pub fn watch_file(
    window: tauri::Window,
    handle: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let event_label = label.clone();
    let watched_path = path.clone();

    // Build and arm the replacement *before* touching the watcher already
    // registered for this window. Dropping the old one first meant a failure
    // in either step below left the window with no watcher at all: the
    // frontend only logs the error, so external edits would silently stop
    // being reported for the rest of the session. Inserting last swaps them
    // in one step — the map drops the previous watcher, which unregisters it.
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            if result.is_ok() {
                let _ = handle.emit_to(event_label.as_str(), "file-changed", watched_path.clone());
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    lock_recover(&state.watchers).insert(label, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_file(window: tauri::Window, state: State<'_, WatcherState>) -> Result<(), String> {
    lock_recover(&state.watchers).remove(window.label());
    Ok(())
}

#[tauri::command]
pub fn send_markdown_path(state: State<'_, AppState>) -> Vec<String> {
    let mut files: Vec<String> = std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .collect();
    let startup_files: Vec<String> = lock_recover(&state.startup_files).drain(..).collect();
    for path in startup_files.into_iter().rev() {
        if !files.contains(&path) {
            files.insert(0, path);
        }
    }
    files
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::Focused(true) => {
            let label = window.label();
            if label == "main" || label.starts_with("window-") {
                let state = window.state::<AppState>();
                *lock_recover(&state.last_focused_viewer) = Some(label.to_string());
            }
        }
        tauri::WindowEvent::Destroyed => {
            let state = window.state::<WatcherState>();
            lock_recover(&state.watchers).remove(window.label());
            let app_state = window.state::<AppState>();
            lock_recover(&app_state.window_registry).remove(window.label());
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
        )
        .unwrap();
        save_pinned_tag_at(
            &lock,
            &path,
            "work".to_string(),
            "#d93025".to_string(),
            vec!["/tmp/b.md".to_string()],
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
    /// succeeds in both worlds: `save_pinned_tag_at` returns `Ok(())` either
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
        )
        .unwrap();
        save_pinned_tag_at(
            &lock,
            &path,
            "Research".to_string(),
            "#d93025".to_string(),
            vec!["/notes/c.md".to_string()],
        )
        .unwrap();

        let tags = read_pinned_tags_at(&path);
        assert_eq!(tags.len(), 1, "one name, one entry — the pin file is keyed by name");
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

        assert!(!tag_held_by_another_window(&registry, "window-3", "research"));
        assert!(!tag_held_by_another_window(&registry, "window-3", "Research notes"));
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
