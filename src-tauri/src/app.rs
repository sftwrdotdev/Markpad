//! The Tauri application itself: the builder chain, the macOS menu, and the
//! command registry.
//!
//! Split out of `lib.rs`; the code is unchanged.

use crate::window_runtime::{AppState, WatcherState};
use crate::{asset_protocol, commands, tab_transfer, window_runtime};
use std::fs;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    #[cfg(target_os = "windows")]
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--enable-features=SmoothScrolling",
        );
    }

    tauri::Builder::default()
        .manage(AppState::new())
        .manage(WatcherState::new())
        .manage(tab_transfer::TabTransferBroker::new())
        // Replaces Tauri's own `asset:` handler, which reads the file on the
        // thread the webview calls it on — see `asset_protocol` for why that
        // freezes every window on an unreachable path. Registering the scheme
        // here is what suppresses the built-in one.
        .register_asynchronous_uri_scheme_protocol("asset", |ctx, request, responder| {
            let scope = ctx.app_handle().asset_protocol_scope();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(asset_protocol::respond(&request, &|path| {
                    scope.is_allowed(path)
                }));
            });
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            window_runtime::handle_single_instance(app, args, cwd);
        }))
        .plugin(tauri_plugin_prevent_default::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::VISIBLE
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                // Detached tab windows share one saved state instead of
                // accumulating a state entry per generated label.
                .map_label(|label| {
                    if label.starts_with("window-") {
                        "secondary"
                    } else {
                        label
                    }
                })
                .build(),
        )
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();

            let label = "main";

            let mut window_builder = tauri::WebviewWindowBuilder::new(
                app,
                label,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Markpad")
            .inner_size(900.0, 650.0)
            .min_inner_size(400.0, 300.0)
            .visible(false)
            // Half of "a cold start does not steal focus"; the other half is
            // `show_window`. Windows maps `show()` to `SW_SHOW`, which
            // activates, so dropping the `set_focus` call there is not enough
            // on its own. This sets tao's one-shot `MARKER_DONT_FOCUS`, which
            // makes the FIRST show use `SW_SHOWNOACTIVATE` and is then cleared,
            // so every later show still comes to the front. On macOS and Linux
            // it is a no-op: tao only reads `focused` for a window that is
            // built visible, and this one is not.
            .focused(false)
            .resizable(true)
            .shadow(false)
            .center();

            #[cfg(target_os = "macos")]
            {
                window_builder = window_builder
                    .decorations(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }

            #[cfg(not(target_os = "macos"))]
            {
                window_builder = window_builder.decorations(false);
            }

            let window = window_builder.build()?;

            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{
                    MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
                };

                let app_name = app.package_info().name.clone();

                let check_item =
                    MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
                let settings_item = MenuItemBuilder::with_id("menu-app-settings", "Settings…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;

                let app_submenu = SubmenuBuilder::new(app, &app_name)
                    .item(&PredefinedMenuItem::about(
                        app,
                        Some(&format!("About {}", app_name)),
                        None,
                    )?)
                    .separator()
                    .item(&settings_item)
                    .item(&check_item)
                    .separator()
                    .item(&PredefinedMenuItem::services(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(app, None)?)
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id("menu-app-quit", format!("Quit {}", app_name))
                            .accelerator("CmdOrCtrl+Q")
                            .build(app)?,
                    )
                    .build()?;

                // WKWebView declines ⌘X/⌘C/⌘V/⌘A/⌘Z in plain inputs and hands
                // them to the main menu, so without an Edit submenu those keys
                // are dead in every native field (settings, modals). Monaco is
                // unaffected either way: it preventDefault()s the key first, so
                // the menu never sees it and its own paste handler still runs.
                let edit_submenu = SubmenuBuilder::new(app, "Edit")
                    .item(&PredefinedMenuItem::undo(app, None)?)
                    .item(&PredefinedMenuItem::redo(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(app, None)?)
                    .item(&PredefinedMenuItem::copy(app, None)?)
                    .item(&PredefinedMenuItem::paste(app, None)?)
                    .item(&PredefinedMenuItem::select_all(app, None)?)
                    .build()?;

                // ⌘M and ⌃⌘F are window-server actions, not document actions:
                // there is no web API the in-window controls could bind them
                // to, so they only exist as long as a menu item carries them.
                // Full Screen belongs in a View menu by convention, but View
                // would hold that one item and nothing else — Markpad's view
                // actions are all in-window (#281) — so it rides here instead.
                let window_submenu = SubmenuBuilder::new(app, "Window")
                    .item(&PredefinedMenuItem::minimize(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::fullscreen(app, None)?)
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .items(&[&app_submenu, &edit_submenu, &window_submenu])
                    .build()?;

                app.set_menu(menu)?;
            }

            let config_dir = app.path().app_config_dir()?;
            let theme_path = config_dir.join("theme.txt");
            let theme_pref =
                fs::read_to_string(theme_path).unwrap_or_else(|_| "system".to_string());

            // An APPEARANCE, written by `save_theme` — see the note there. It
            // used to be the raw theme setting, which meant every `vscode:<name>`
            // theme landed in the fallback arm below and asked the OS instead: a
            // dark VS Code theme on a light desktop flashed a white window on
            // every launch. A file left over from that older format still lands
            // there, and self-corrects as soon as the frontend applies its theme.
            let bg_color = match theme_pref.as_str() {
                "dark" => Some(tauri::window::Color(24, 24, 24, 255)),
                "light" => Some(tauri::window::Color(253, 253, 253, 255)),
                _ => {
                    if let Ok(t) = window.theme() {
                        match t {
                            tauri::Theme::Dark => Some(tauri::window::Color(24, 24, 24, 255)),
                            _ => Some(tauri::window::Color(253, 253, 253, 255)),
                        }
                    } else {
                        Some(tauri::window::Color(253, 253, 253, 255))
                    }
                }
            };

            let _ = window.set_background_color(bg_color);

            let _ = window.set_shadow(true);

            // Same vetting as `send_markdown_path`, which reads the same argv:
            // the frontend consumes BOTH channels, so a path this one lets
            // through reaches `loadMarkdown` no matter what the other decides.
            let startup_files =
                window_runtime::startup_paths(&args, &std::env::current_dir().unwrap_or_default());

            if let Some(path) = startup_files.first() {
                let _ = window.emit("file-path", path.as_str());
                window_runtime::bring_to_front(&window);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::clipboard_write_text,
            commands::clipboard_read_text,
            commands::clipboard_read_image,
            commands::open_markdown_preview,
            commands::render_markdown,
            commands::markdown_semantic_spans,
            commands::list_heading_anchors,
            window_runtime::send_markdown_path,
            commands::read_file_content_checked,
            commands::canonicalize_path,
            commands::read_file_as_data_url,
            commands::save_file_content,
            commands::sweep_temp_files,
            commands::export_pdf_windows,
            commands::print_pdf,
            commands::is_win11,
            commands::open_file_folder,
            commands::rename_file,
            commands::watch_file,
            window_runtime::unwatch_file,
            window_runtime::show_window,
            commands::save_theme,
            commands::get_system_fonts,
            commands::get_os_type,
            commands::self_update_supported,
            commands::fetch_vscode_theme,
            commands::get_saved_vscode_themes,
            commands::read_vscode_theme,
            commands::delete_vscode_theme,
            commands::save_image,
            commands::copy_file_to_img,
            commands::copy_file,
            commands::list_directory_contents,
            tab_transfer::stage_detached_tab,
            tab_transfer::claim_detached_tab,
            tab_transfer::complete_detached_tab,
            tab_transfer::cancel_detached_tab,
            commands::create_transfer_window,
            window_runtime::set_window_meta,
            window_runtime::list_viewer_windows,
            window_runtime::is_window_tag_taken,
            window_runtime::offer_tab_to_window,
            window_runtime::focus_window,
            window_runtime::list_pinned_tags,
            window_runtime::save_pinned_tag,
            window_runtime::remove_pinned_tag,
            window_runtime::save_window_state,
            window_runtime::load_window_state,
            window_runtime::clear_window_state,
            window_runtime::save_restore_progress,
            window_runtime::load_restore_progress,
            window_runtime::clear_restore_progress
        ])
        .on_window_event(window_runtime::handle_window_event)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            // Emit to the focused webview window's label rather than
            // `window.emit(...)`, which broadcasts to every webview and
            // would fire menu actions (New/Close/Save…) in all windows at
            // once. Falls back to "main" if no window is focused (e.g. menu
            // fired while the app is in the background).
            let target = app
                .webview_windows()
                .into_values()
                .find(|w| w.is_focused().unwrap_or(false))
                .or_else(|| app.get_webview_window("main"));
            let Some(window) = target else { return };

            if id == "menu-app-settings" {
                let _ = app.emit_to(window.label(), "menu-app-settings", ());
            } else if id == "check-updates" {
                let _ = app.emit_to(window.label(), "menu-check-updates", ());
            } else if id == "menu-app-quit" {
                let _ = app.emit_to(window.label(), id, ());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                for url in urls {
                    if let Ok(path_buf) = url.to_file_path() {
                        let path_str = path_buf.to_string_lossy().to_string();

                        let state = _app_handle.state::<AppState>();
                        window_runtime::lock_recover(&state.startup_files).push(path_str.clone());

                        if let Some(window) = window_runtime::pick_delivery_window(_app_handle) {
                            let _ = _app_handle.emit_to(window.label(), "file-path", path_str);
                            window_runtime::bring_to_front(&window);
                        }
                    }
                }
            }
        });
}
