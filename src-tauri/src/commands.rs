//! Every `#[tauri::command]` the frontend can `invoke`, plus the blocking
//! helpers they run on the pool.
//!
//! Split out of `lib.rs`; the code and its tests are unchanged.

use crate::fs_safety::{
    atomic_write, canonical_identity, encode_text, ensure_path_within_root, read_to_string_lossy,
    resolve_image_directory, safe_path_component, sweep_document_temps,
};
use crate::markdown::{build_markdown_preview, convert_markdown, heading_anchors, HeadingAnchor};
use crate::window_runtime::{self, WatcherState};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};

const MAX_VSIX_DOWNLOAD_BYTES: usize = 20 * 1024 * 1024;
const MAX_VSIX_ENTRIES: usize = 10_000;
const MAX_VSIX_UNCOMPRESSED_BYTES: u64 = 100 * 1024 * 1024;
const MAX_THEME_JSON_BYTES: u64 = 2 * 1024 * 1024;
const VSIX_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const VSIX_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Reads a VSIX entry as text under a hard byte ceiling.
///
/// The `size()` checks elsewhere use the size the archive *declares* in its
/// central directory, which a hostile file is free to understate — the zip
/// reader only bounds the *compressed* stream, so a small entry claiming to
/// be 1 KB can still inflate without limit. Reading through `take` makes the
/// ceiling apply to the bytes actually produced.
fn read_zip_entry_to_string<R: std::io::Read>(entry: R, limit: u64) -> Result<String, String> {
    use std::io::Read;
    let mut text = String::new();
    entry
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > limit {
        return Err("VSIX entry exceeds the allowed size".to_string());
    }
    Ok(text)
}

fn validate_vsix_archive_limits<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<(), String> {
    if archive.len() > MAX_VSIX_ENTRIES {
        return Err("VSIX contains too many files".to_string());
    }

    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|e| e.to_string())?;
        total_size = total_size
            .checked_add(file.size())
            .ok_or("VSIX uncompressed size overflow")?;
        if total_size > MAX_VSIX_UNCOMPRESSED_BYTES {
            return Err("VSIX expands beyond the allowed size".to_string());
        }
    }
    Ok(())
}

/// Creates the destination window for a tab transfer. The window's label
/// embeds the transfer token ("window-<token>"), so the new frontend can
/// derive which pending transfer to claim from its own label — no URL
/// query involved (the asset protocol 404s on "index.html?x=y" paths).
/// Deliberately async. `WebviewWindowBuilder::build()` deadlocks on Windows
/// when it runs inside a synchronous command: WebView2 needs the main thread
/// to pump messages while the webview is created, but a sync command IS the
/// main thread, blocked waiting for build() to return. The whole app then
/// freezes — no new window, no menus, an unresponsive close button
/// (tauri-apps/tauri#12521). An async command runs off the event loop, and
/// Tauri dispatches the actual window creation to the main thread itself, so
/// macOS's main-thread requirement is still satisfied.
#[tauri::command]
pub async fn create_transfer_window(app: AppHandle, token: String) -> Result<(), String> {
    window_runtime::create_transfer_window(app, token)
}

/// Returns `(html, content, is_full, lossy, encoding)`. See `DecodedText`: the
/// frontend refuses to write a `lossy` buffer back over its file, and saves a
/// faithful one as the `encoding` it came in.
#[tauri::command]
pub async fn open_markdown_preview(
    path: String,
    max_bytes: usize,
) -> Result<(String, String, bool, bool, String), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let preview = build_markdown_preview(Path::new(&path), max_bytes)?;
        Ok((
            preview.html,
            preview.content,
            preview.is_full,
            preview.lossy,
            preview.encoding,
        ))
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
pub async fn list_heading_anchors(markdown: String) -> Result<Vec<HeadingAnchor>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(heading_anchors(&markdown)))
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

/// The ranges the editor should colour, from the same parse the preview uses.
///
/// Off the main thread like `render_markdown`: measured at 0.7 ms for a 500-line
/// document and 24 ms for a 1.7 MB one, which is small but not nothing, and
/// Monaco asks for this on every edit.
#[tauri::command]
pub async fn markdown_semantic_spans(
    content: String,
) -> Result<Vec<crate::semantic::SemanticSpan>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(crate::semantic::semantic_spans(&content)))
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
pub async fn render_markdown(content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(convert_markdown(&content)))
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

/// Reads a file, with the fidelity of the decode and the encoding it was
/// decoded from: returns `(content, lossy, encoding)`. A caller that puts the
/// text into an EDITABLE buffer must carry BOTH onto the tab — `lossy` so the
/// first auto-save does not write U+FFFD over a file that could not be read,
/// and `encoding` so it does not write UTF-8 over one that could.
///
/// This is now the only read-to-string command. Its sibling
/// `read_file_content` returned the text and dropped the verdict; it survived
/// #379 for callers that re-read a file whose tab was already flagged, then
/// lost its last call site and stayed registered — a command whose defining
/// property is that it hides the flag, one `invoke` away from any new caller.
/// Deleting it makes "which command should this use" a question with one
/// answer rather than a convention.
///
/// Deliberately async, like every other file-touching command here. A
/// synchronous `#[tauri::command]` runs on the main thread, so a read from a
/// slow volume (SMB, iCloud, a failing USB stick) freezes the whole
/// application — every window, its menus and its scrolling — until the I/O
/// returns. `spawn_blocking` moves the wait onto the blocking pool, which is
/// what `tauri::async_runtime` provides it for.
#[tauri::command]
pub async fn read_file_content_checked(path: String) -> Result<(String, bool, String), String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_to_string_lossy(&path)
            .map(|decoded| (decoded.content, decoded.lossy, decoded.encoding))
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

fn mime_type_for_export_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

fn file_bytes_to_data_url(mime_type: &str, bytes: &[u8]) -> String {
    use base64::{engine::general_purpose, Engine as _};
    format!(
        "data:{};base64,{}",
        mime_type,
        general_purpose::STANDARD.encode(bytes)
    )
}

#[tauri::command]
pub async fn read_file_as_data_url(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let mime_type = mime_type_for_export_path(Path::new(&path));
        Ok(file_bytes_to_data_url(mime_type, &bytes))
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Writes `content` to `path` as `encoding` — the label the file was decoded
/// from, so a legacy document is saved as the bytes it arrived as instead of
/// being silently converted to UTF-8 behind the user's back. Callers with text
/// Markpad generated itself (the HTML and SVG exports) pass `UTF-8`.
///
/// The label is not trusted: it makes a round trip through the frontend, and
/// `encode_text` rejects one it does not recognise rather than falling back to
/// a default that would write the wrong bytes.
///
/// Encoding happens BEFORE `atomic_write`, so a document with a character its
/// encoding cannot represent fails without the file being touched at all.
///
/// Async because `atomic_write` fsyncs twice (the file, then its directory).
/// On a network or removable volume that is seconds of blocking I/O, and on
/// the main thread it would stall every window until the save completes.
#[tauri::command]
pub async fn save_file_content(
    path: String,
    content: String,
    encoding: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = encode_text(&content, &encoding)?;
        atomic_write(Path::new(&path), &bytes).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Clear temp files earlier runs left beside the documents this window knows
/// about — the recent-file list, and whatever the session restored.
///
/// A save already sweeps the document it is writing, and that is the sweep
/// that matters while someone is working. It cannot reach a document nobody
/// opens again, whose leftovers would otherwise stay in the user's folder for
/// good, so startup asks for the documents Markpad remembers (#722).
///
/// Every window calls this and only the first pays for it: the sweep is once
/// per document per run, and Markpad's windows share a process.
///
/// Async and off the main thread: this is a `read_dir` per document on folders
/// that may live on a network volume, and nothing waits for the result.
#[tauri::command]
pub async fn sweep_temp_files(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for path in paths {
            sweep_document_temps(Path::new(&path));
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Resolve `path` to the identity the filesystem gives it — see
/// `canonical_identity` for what that folds and why the filesystem, rather
/// than a platform guess, is the thing being asked.
///
/// The frontend calls this once per path, when the path ENTERS the app, and
/// keeps the answer on the tab (`Tab.pathKey`). Comparisons themselves stay
/// synchronous string equality: `TabManager.claimPath` runs on every navigate
/// and cannot become async without turning six sync call sites into promises.
///
/// Async because `realpath` walks the path component by component and can hit
/// a network volume that is slow or unreachable.
#[tauri::command]
pub async fn canonicalize_path(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        canonical_identity(Path::new(&path))
            .map(|resolved| resolved.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
pub fn print_pdf(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn export_pdf_windows(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::sync::mpsc::sync_channel;
        use std::time::Duration;
        use webview2_com::{
            Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7},
            PrintToPdfCompletedHandler,
        };
        use windows::core::{Interface, HSTRING};

        let (sender, receiver) = sync_channel(1);
        window
            .with_webview(move |platform_webview| unsafe {
                let result = (|| -> Result<(), String> {
                    let controller = platform_webview.controller();
                    let webview = controller
                        .CoreWebView2()
                        .map_err(|error| format!("failed to access WebView2: {error}"))?
                        .cast::<ICoreWebView2_7>()
                        .map_err(|error| {
                            format!("WebView2 runtime does not support PDF export: {error}")
                        })?;
                    let settings = platform_webview
                        .environment()
                        .cast::<ICoreWebView2Environment6>()
                        .map_err(|error| {
                            format!("WebView2 runtime does not support print settings: {error}")
                        })?
                        .CreatePrintSettings()
                        .map_err(|error| format!("failed to create PDF print settings: {error}"))?;

                    settings
                        .SetShouldPrintHeaderAndFooter(false)
                        .map_err(|error| {
                            format!("failed to disable PDF headers and footers: {error}")
                        })?;
                    settings
                        .SetShouldPrintBackgrounds(true)
                        .map_err(|error| format!("failed to enable PDF backgrounds: {error}"))?;

                    let callback_sender = sender.clone();
                    let completion =
                        PrintToPdfCompletedHandler::create(Box::new(move |status, succeeded| {
                            let result = status
                                .map_err(|error| format!("WebView2 PDF export failed: {error}"))
                                .and_then(|_| {
                                    succeeded.then_some(()).ok_or_else(|| {
                                        "WebView2 did not create the PDF file".to_string()
                                    })
                                });
                            let _ = callback_sender.send(result);
                            Ok(())
                        }));

                    webview
                        .PrintToPdf(&HSTRING::from(path), &settings, &completion)
                        .map_err(|error| format!("could not start PDF export: {error}"))
                })();

                if let Err(error) = result {
                    let _ = sender.send(Err(error));
                }
            })
            .map_err(|error| format!("failed to schedule PDF export: {error}"))?;

        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(60)))
            .await
            .map_err(|error| format!("PDF export task failed: {error}"))?
            .map_err(|error| format!("PDF export callback failed or timed out: {error}"))?
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, path);
        Err("controlled PDF export is only available on Windows".to_string())
    }
}

/// Async because `reveal` blocks its caller until the file manager answers:
/// on Windows it spawns a COM worker for `SHOpenFolderAndSelectItems` and
/// joins it, on macOS it waits for `open -R`. Selecting a file on a network
/// volume makes that wait the share's, and on the main thread it would stall
/// every window until it returns.
#[tauri::command]
pub async fn open_file_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || opener::reveal(path).map_err(|e| e.to_string()))
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

/// Async because a rename is a round trip to whatever holds the path — on a
/// network or removable volume, seconds of blocking I/O for a metadata
/// operation that looks instant on a local disk.
#[tauri::command]
pub async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::rename(old_path, new_path).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Async because arming a watcher opens the watched path, and an unreachable
/// one costs the full share timeout before it fails — `\\wsl$\…` with the
/// distro stopped is the case that prompted this. Inserting the new watcher
/// also drops the window's previous one, and that drop joins its thread.
///
/// `State` is resolved inside the closure rather than taken as a parameter:
/// `State<'_, _>` borrows from the app and cannot cross into a `'static`
/// blocking task. It is injected by Tauri either way, so the command's
/// frontend-facing arguments are unchanged.
#[tauri::command]
pub async fn watch_file(
    window: tauri::Window,
    handle: AppHandle,
    path: String,
) -> Result<(), String> {
    let state_handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = state_handle.state::<WatcherState>();
        window_runtime::watch_file(window, handle, state, path)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Records what colour the NEXT window should be painted before it has a webview.
///
/// The argument is an appearance — `"dark"`, `"light"` or `"system"` — and not
/// the theme the user picked. The theme itself is a frontend setting that lives
/// in `localStorage`, and one of its forms, `vscode:<name>`, is dark or light
/// according to a `type` field inside an imported JSON file. Resolving that here
/// would mean a second theme parser in Rust; the frontend has already parsed the
/// file by the time it applies the theme, so it sends the answer instead.
/// `app.rs` is the only reader — see the background colour it picks at startup.
#[tauri::command]
pub fn save_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let theme_path = config_dir.join("theme.txt");
    atomic_write(&theme_path, theme.as_bytes()).map_err(|e| e.to_string())
}

fn theme_slug(value: &str) -> String {
    let lowercase = value.to_lowercase();
    lowercase
        .split(|c: char| !c.is_alphanumeric())
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[tauri::command]
pub async fn fetch_vscode_theme(app: AppHandle, url: String) -> Result<String, String> {
    use std::io::Cursor;
    // Parse URL: e.g. https://vscodethemes.com/e/teabyii.ayu/ayu-dark-bordered
    let parts: Vec<&str> = url.split('/').collect();
    if parts.len() < 5 || parts[3] != "e" {
        return Err("Invalid vscodethemes.com URL".to_string());
    }
    let pub_ext = parts[4];
    let theme_name = parts
        .get(5)
        .unwrap_or(&"")
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();
    let pe_parts: Vec<&str> = pub_ext.split('.').collect();
    if pe_parts.len() != 2 {
        return Err("Invalid extension format in URL".to_string());
    }
    let publisher = pe_parts[0];
    let extension = pe_parts[1];

    let vsix_url = format!("https://{publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/{publisher}/extension/{extension}/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage");

    // Bound the request explicitly. `reqwest::get` has no timeout at all, so
    // a marketplace host that accepts the connection and then stalls leaves
    // the theme import pending for the rest of the session.
    let client = reqwest::Client::builder()
        .connect_timeout(VSIX_CONNECT_TIMEOUT)
        .timeout(VSIX_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(&vsix_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "VSIX download failed with HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_VSIX_DOWNLOAD_BYTES as u64)
    {
        return Err("VSIX download exceeds the allowed size".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_VSIX_DOWNLOAD_BYTES {
            return Err("VSIX download exceeds the allowed size".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    let reader = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
    validate_vsix_archive_limits(&mut archive)?;

    let package_json_data = if let Ok(file) = archive.by_name("extension/package.json") {
        if file.size() > MAX_THEME_JSON_BYTES {
            return Err("VSIX package manifest exceeds the allowed size".to_string());
        }
        read_zip_entry_to_string(file, MAX_THEME_JSON_BYTES)?
    } else {
        return Err("No package.json found in VSIX".to_string());
    };

    let package_json: serde_json::Value =
        serde_json::from_str(&package_json_data).map_err(|e| e.to_string())?;
    let themes = package_json
        .get("contributes")
        .and_then(|c| c.get("themes"))
        .and_then(|t| t.as_array())
        .ok_or("No themes found in extension")?;

    let mut theme_path = None;
    let mut matched_name_str = theme_name.clone();

    for t in themes {
        let label = t
            .get("label")
            .or(t.get("id"))
            .and_then(|l| l.as_str())
            .unwrap_or("");
        let path = t.get("path").and_then(|p| p.as_str()).unwrap_or("");

        let label_slug = theme_slug(label);

        // If theme_name is empty, just take the first one
        if theme_name.is_empty()
            || label_slug == theme_name.to_lowercase()
            || path.to_lowercase().contains(&theme_name.to_lowercase())
        {
            theme_path = Some(path.to_string());
            if theme_name.is_empty() {
                matched_name_str = label_slug;
            }
            break;
        }
    }

    if let Some(mut path) = theme_path {
        if path.starts_with("./") {
            path = path[2..].to_string();
        }
        let full_path = format!("extension/{}", path).replace("\\", "/");
        let theme_file = archive.by_name(&full_path).map_err(|e| e.to_string())?;
        if theme_file.size() > MAX_THEME_JSON_BYTES {
            return Err("VSIX theme file exceeds the allowed size".to_string());
        }
        let theme_json = read_zip_entry_to_string(theme_file, MAX_THEME_JSON_BYTES)?;

        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let themes_dir = config_dir.join("themes");
        fs::create_dir_all(&themes_dir).map_err(|e| e.to_string())?;

        let dest_name = if matched_name_str.is_empty() {
            "downloaded_theme".to_string()
        } else {
            matched_name_str.clone()
        };
        let dest_name = safe_path_component(&dest_name, "theme name")?;
        let theme_file_path = themes_dir.join(format!("{}.json", dest_name));
        atomic_write(&theme_file_path, theme_json.as_bytes()).map_err(|e| e.to_string())?;

        return Ok(dest_name.to_string());
    }

    Err("Theme name not found in extension".to_string())
}

#[tauri::command]
pub fn get_saved_vscode_themes(app: AppHandle) -> Result<Vec<String>, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let themes_dir = config_dir.join("themes");
    let mut themes = Vec::new();
    if let Ok(entries) = fs::read_dir(themes_dir) {
        for entry in entries.flatten() {
            if let Some(ext) = entry.path().extension() {
                if ext == "json" {
                    if let Some(name) = entry.path().file_stem().and_then(|n| n.to_str()) {
                        themes.push(name.to_string());
                    }
                }
            }
        }
    }
    Ok(themes)
}

#[tauri::command]
pub fn read_vscode_theme(app: AppHandle, name: String) -> Result<String, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let name = safe_path_component(&name, "theme name")?;
    let theme_file_path = config_dir.join("themes").join(format!("{}.json", name));
    fs::read_to_string(theme_file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_vscode_theme(app: AppHandle, name: String) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let name = safe_path_component(&name, "theme name")?;
    let theme_file_path = config_dir.join("themes").join(format!("{}.json", name));
    fs::remove_file(theme_file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn is_win11() -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hklim = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(current_version) =
            hklim.open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        {
            if let Ok(current_build) = current_version.get_value::<String, _>("CurrentBuild") {
                if let Ok(build_num) = current_build.parse::<u32>() {
                    return build_num >= 22000;
                }
            }
        }
    }
    false
}

/// Async because enumerating every installed font family is a slow,
/// filesystem-heavy call (fontconfig on Linux, DirectWrite on Windows,
/// CoreText on macOS) and the settings dialog invokes it on open. On the main
/// thread it stalls every window for the duration.
#[tauri::command]
pub async fn get_system_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        use font_kit::source::SystemSource;
        let source = SystemSource::new();
        let mut families = source.all_families().unwrap_or_default();
        families.sort();
        families.dedup();
        families
    })
    .await
    .unwrap_or_default()
}

/// Whether this install is able to replace its own binary.
///
/// `tauri-plugin-updater` has exactly one install strategy on Linux: rename the
/// downloaded file over the running executable. That works for an AppImage,
/// which is a file the user owns, and for nothing else — a `.deb` or `.rpm`
/// puts the binary in `/usr/bin` and a snap mounts it from a read-only
/// squashfs.
///
/// It would normally choose `install_deb` / `install_rpm` instead, from a bundle
/// type patched into the binary after the build. That patch fails on Linux —
/// three `Failed to add bundler type to the binary` warnings in every release
/// build, one per bundle — so `tauri_utils::platform::bundle_type()` returns
/// `None` and all three formats fall through to the AppImage path. Those users
/// were told an update existed and then watched it fail to install. See #570;
/// `build.yml` already documents the same missing symbol for a different
/// consequence, the shape of `latest.json`'s platform keys.
///
/// Read through `Env` rather than `std::env::var("APPIMAGE")` directly: tauri
/// also checks that the running executable sits under `$TMPDIR/.mount_`, so
/// setting the variable by hand cannot make a package-managed install claim it
/// is updatable.
///
/// Windows and macOS are unaffected. Windows' updater runs the downloaded NSIS
/// installer rather than overwriting anything in place, and macOS is the one
/// platform where `bundle_type()` answers without the patch.
#[tauri::command]
pub fn self_update_supported(app: AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    {
        app.env().appimage.is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        true
    }
}

#[tauri::command]
pub fn get_os_type() -> String {
    #[cfg(target_os = "macos")]
    {
        "macos".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "windows".to_string()
    }
    #[cfg(target_os = "linux")]
    {
        "linux".to_string()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "unknown".to_string()
    }
}

#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_read_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.get_text().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_read_image(macos_image_scaling: bool) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    let _ = macos_image_scaling;

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let image = clipboard.get_image().map_err(|e| e.to_string())?;

    // encode as png
    let mut png_data = Vec::new();
    {
        let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
        use image::ImageEncoder;

        // Check if running on macOS and scale image if needed
        #[cfg(target_os = "macos")]
        {
            if macos_image_scaling {
                // Use image crate for high-quality scaling
                use image::{DynamicImage, ImageBuffer, Rgba};

                // Convert arboard Image to ImageBuffer
                let mut img_buffer = ImageBuffer::new(image.width as u32, image.height as u32);
                for (x, y, pixel) in img_buffer.enumerate_pixels_mut() {
                    let idx = (y * image.width as u32 + x) as usize * 4;
                    if idx + 3 < image.bytes.len() {
                        *pixel = Rgba([
                            image.bytes[idx],
                            image.bytes[idx + 1],
                            image.bytes[idx + 2],
                            image.bytes[idx + 3],
                        ]);
                    }
                }

                // Create DynamicImage
                let dynamic_image = DynamicImage::ImageRgba8(img_buffer);

                // Resize with high-quality Lanczos3 filter
                let resized = dynamic_image.resize(
                    (image.width / 2) as u32,
                    (image.height / 2) as u32,
                    image::imageops::FilterType::Lanczos3,
                );

                // Write the resized image
                let resized_rgba = resized.to_rgba8();
                encoder
                    .write_image(
                        resized_rgba.as_raw(),
                        (image.width / 2) as u32,
                        (image.height / 2) as u32,
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(|e| e.to_string())?;
            } else {
                // Use original image if scaling is disabled
                encoder
                    .write_image(
                        image.bytes.as_ref(),
                        image.width as u32,
                        image.height as u32,
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(|e| e.to_string())?;
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            // For other platforms, use the original image
            encoder
                .write_image(
                    image.bytes.as_ref(),
                    image.width as u32,
                    image.height as u32,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;
        }
    }

    use base64::{engine::general_purpose, Engine as _};
    Ok(general_purpose::STANDARD.encode(&png_data))
}

#[tauri::command]
pub async fn save_image(
    parent_dir: String,
    filename: String,
    base64_data: String,
    image_directory: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_image_blocking(&parent_dir, &filename, &base64_data, &image_directory)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

fn save_image_blocking(
    parent_dir: &str,
    filename: &str,
    base64_data: &str,
    image_directory: &str,
) -> Result<String, String> {
    let filename = safe_path_component(filename, "image filename")?;
    let (root, img_dir) = resolve_image_directory(parent_dir, image_directory)?;
    let file_path = img_dir.join(filename);
    ensure_path_within_root(&root, &file_path)?;

    // remove potential data:image/png;base64, prefix
    let b64 = if let Some(pos) = base64_data.find("base64,") {
        &base64_data[pos + 7..]
    } else {
        base64_data
    };

    use base64::{engine::general_purpose, Engine as _};
    let bytes = general_purpose::STANDARD
        .decode(b64)
        .map_err(|e: base64::DecodeError| e.to_string())?;

    atomic_write(&file_path, &bytes).map_err(|e| e.to_string())?;

    let rel_path = if image_directory.is_empty() {
        filename.to_string()
    } else {
        format!("{}/{}", image_directory, filename)
    };

    Ok(rel_path)
}

#[tauri::command]
pub async fn copy_file_to_img(
    src_path: String,
    parent_dir: String,
    image_directory: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        copy_file_to_img_blocking(&src_path, &parent_dir, &image_directory)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// How many conflict names to try before giving up. Chromium's download path
/// reservation gives up after 100 for the same reason: past that, the user is
/// better served by an error than by an unbounded directory scan.
const MAX_IMG_NAME_ATTEMPTS: u32 = 100;

/// Builds the `attempt`-th conflict name, e.g. `photo_1.png`, `photo_2.png`.
///
/// Every mainstream implementation resolves a name conflict with an
/// incrementing counter — Chrome/Firefox downloads (`photo (1).png`), Windows
/// Explorer (`photo (2).png`), macOS Finder (`photo 2.png`) — and none uses a
/// timestamp. They disagree only on the decoration, so this picks the one that
/// survives the destination: the name is about to be pasted into a Markdown
/// link, where parentheses are metacharacters and spaces need escaping, while
/// `_` needs neither. It is also the separator this function already used.
///
/// An empty extension gets no separator: `Path::extension()` is `None` for a
/// dotfile such as `.png`, and appending the dot unconditionally produced
/// `photo_1.` — a name Windows silently creates *without* the trailing dot,
/// leaving the link written into the document pointing at nothing.
fn img_conflict_name(stem: &str, ext: &str, attempt: u32) -> String {
    if ext.is_empty() {
        format!("{stem}_{attempt}")
    } else {
        format!("{stem}_{attempt}.{ext}")
    }
}

fn copy_file_to_img_blocking(
    src_path: &str,
    parent_dir: &str,
    image_directory: &str,
) -> Result<String, String> {
    let (root, img_dir) = resolve_image_directory(parent_dir, image_directory)?;

    let src = Path::new(src_path);
    if !src.exists() {
        return Err("Source file does not exist".to_string());
    }

    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid source filename".to_string())?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");

    let mut source = fs::File::open(src).map_err(|e| e.to_string())?;

    // The destination name is claimed with `create_new`, which is a single
    // atomic syscall (`O_EXCL` / `CREATE_NEW`): whoever creates the file wins
    // and everyone else gets `AlreadyExists` and moves to the next name. The
    // previous code tested `exists()` and then copied, so two drops that
    // computed the same name — trivially, since the name carried a
    // second-resolution timestamp that was never re-checked — both saw the
    // name as free and the second overwrote an image the document already
    // linked to.
    //
    // Residual races: `O_EXCL` is not reliable on old NFSv2 mounts, and
    // nothing stops an outside process from deleting our file after we create
    // it. Neither is a same-app data-loss path, which is what this guards.
    // Streaming into the handle we just created, rather than `fs::copy`, also
    // means the copy no longer inherits the source's permission bits — a
    // read-only original used to produce a read-only file in `img/`.
    let mut dest_name = file_name.to_string();
    let mut attempt: u32 = 0;
    loop {
        let candidate = img_dir.join(&dest_name);
        ensure_path_within_root(&root, &candidate)?;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut dest) => {
                // The name is ours; only the bytes can still fail. Drop the
                // placeholder if they do, so a failed drop does not leave a
                // truncated image behind under a name the user may reuse.
                if let Err(e) = std::io::copy(&mut source, &mut dest) {
                    drop(dest);
                    let _ = fs::remove_file(&candidate);
                    return Err(e.to_string());
                }
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                attempt += 1;
                if attempt > MAX_IMG_NAME_ATTEMPTS {
                    return Err(format!(
                        "Too many images named \"{}\" in this folder",
                        file_name
                    ));
                }
                dest_name = img_conflict_name(stem, ext, attempt);
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    let rel_path = if image_directory.is_empty() {
        dest_name
    } else {
        format!("{}/{}", image_directory, dest_name)
    };

    Ok(rel_path)
}

/// Async because `fs::copy` streams the whole file. On a network or removable
/// volume that is seconds of blocking I/O, and on the main thread it would
/// stall every window until the copy completes — the same reason its sibling
/// `copy_file_to_img` already runs on the blocking pool.
#[tauri::command]
pub async fn copy_file(src: String, dest: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
pub async fn list_directory_contents(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = Path::new(&path);
        if !dir.exists() || !dir.is_dir() {
            return Err("Not a directory".to_string());
        }

        let mut entries = Vec::new();
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                entries.push(format!("{}/", name));
            } else {
                entries.push(name);
            }
        }
        Ok(entries)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fs_safety::tests::temp_path;
    use std::path::PathBuf;

    #[test]
    fn zip_entry_reads_stop_at_the_limit_even_when_the_header_understates_size() {
        let payload = vec![b'a'; 64];
        assert_eq!(
            read_zip_entry_to_string(payload.as_slice(), 64)
                .unwrap()
                .len(),
            64,
        );
        assert!(
            read_zip_entry_to_string(payload.as_slice(), 32).is_err(),
            "an entry larger than the ceiling must be rejected, not buffered",
        );
    }

    #[test]
    fn export_data_url_uses_mime_from_extension_case_insensitively() {
        assert_eq!(
            mime_type_for_export_path(Path::new("diagram.PNG")),
            "image/png"
        );
        assert_eq!(
            mime_type_for_export_path(Path::new("photo.JpEg")),
            "image/jpeg"
        );
        assert_eq!(
            mime_type_for_export_path(Path::new("vector.svg")),
            "image/svg+xml"
        );
        assert_eq!(
            mime_type_for_export_path(Path::new("unknown.bin")),
            "application/octet-stream"
        );
    }

    #[test]
    fn export_data_url_encodes_bytes_with_mime() {
        assert_eq!(
            file_bytes_to_data_url("image/png", b"Markpad"),
            "data:image/png;base64,TWFya3BhZA==",
        );
    }

    #[test]
    fn theme_slug_collapses_punctuation_runs() {
        assert_eq!(theme_slug("SynthWave '84"), "synthwave-84");
    }

    /// Creates `<root>/src<i>/<name>` holding `body` and returns its path.
    fn drop_source(root: &Path, index: usize, name: &str, body: &[u8]) -> PathBuf {
        let dir = root.join(format!("src{index}"));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        fs::write(&file, body).unwrap();
        file
    }

    fn drop_into_img(src: &Path, doc_dir: &Path) -> String {
        copy_file_to_img_blocking(src.to_str().unwrap(), doc_dir.to_str().unwrap(), "img").unwrap()
    }

    #[test]
    fn repeated_drops_of_the_same_name_never_overwrite_an_earlier_copy() {
        // Three same-named images from different folders, dropped in the same
        // second. The conflict name used to be a *second-resolution* timestamp
        // that was never re-checked for existence, so drops #2 and #3 computed
        // the identical name and #3 silently replaced the bytes behind a link
        // the document had already been given.
        let root = temp_path("imgcopy-repeat");
        let doc_dir = root.join("doc");
        fs::create_dir_all(&doc_dir).unwrap();
        let bodies: [&[u8]; 3] = [b"first", b"second", b"third"];
        let sources: Vec<PathBuf> = bodies
            .iter()
            .enumerate()
            .map(|(i, body)| drop_source(&root, i, "a.png", body))
            .collect();

        let written: Vec<String> = sources
            .iter()
            .map(|src| drop_into_img(src, &doc_dir))
            .collect();

        let distinct: std::collections::HashSet<&String> = written.iter().collect();
        assert_eq!(
            distinct.len(),
            written.len(),
            "two drops shared a name: {written:?}"
        );
        for (rel, body) in written.iter().zip(bodies.iter()) {
            assert_eq!(
                fs::read(doc_dir.join(rel)).unwrap(),
                *body,
                "{rel} no longer holds the image that was dropped for it",
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_conflicting_dotfile_name_does_not_grow_a_trailing_dot() {
        // ".png" is a dotfile, not an extension: the frontend's drop filter
        // reads the name with `split('.').pop()` and sees "png", so it lets it
        // through, while Rust's `Path::extension()` returns None. The old
        // format string appended the separator unconditionally, so the conflict
        // name ended in a dot. Windows strips a trailing dot when creating the
        // file, so the link written into the document named a file that does
        // not exist on disk; mac/Linux keep the dot and the link resolves.
        let root = temp_path("imgcopy-dotfile");
        let doc_dir = root.join("doc");
        fs::create_dir_all(&doc_dir).unwrap();
        let first = drop_source(&root, 0, ".png", b"first");
        let second = drop_source(&root, 1, ".png", b"second");

        drop_into_img(&first, &doc_dir);
        let rel = drop_into_img(&second, &doc_dir);

        assert!(!rel.ends_with('.'), "conflict name ends in a dot: {rel}");
        assert_eq!(fs::read(doc_dir.join(&rel)).unwrap(), b"second");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_drops_of_the_same_name_each_get_their_own_file() {
        // Two windows dropping the same image at the same moment: an
        // `exists()` test followed by a separate copy leaves a window in which
        // both callers see the name as free and one copy lands on top of the
        // other.
        const DROPS: usize = 8;
        let root = temp_path("imgcopy-concurrent");
        let doc_dir = root.join("doc");
        fs::create_dir_all(&doc_dir).unwrap();
        let sources: Vec<(PathBuf, Vec<u8>)> = (0..DROPS)
            .map(|i| {
                let body = format!("image-{i}").into_bytes();
                (drop_source(&root, i, "a.png", &body), body)
            })
            .collect();

        let written: Vec<(String, Vec<u8>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = sources
                .iter()
                .map(|(src, body)| {
                    let doc_dir = doc_dir.clone();
                    scope.spawn(move || (drop_into_img(src, &doc_dir), body.clone()))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        let distinct: std::collections::HashSet<&String> =
            written.iter().map(|(rel, _)| rel).collect();
        assert_eq!(
            distinct.len(),
            DROPS,
            "concurrent drops shared a name: {written:?}"
        );
        for (rel, body) in &written {
            assert_eq!(
                &fs::read(doc_dir.join(rel)).unwrap(),
                body,
                "{rel} no longer holds the image that was dropped for it",
            );
        }

        fs::remove_dir_all(root).unwrap();
    }
}
