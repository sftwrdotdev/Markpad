//! The Tauri application itself: the builder chain and the command registry.
//! The macOS menu bar is built by each window's frontend (`appMenu.ts`).

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
        // The frontend installs the menu; Tauri's default would answer ⌘W and
        // friends natively until it does.
        .enable_macos_default_menu(false)
        .manage(AppState::new())
        .manage(WatcherState::new())
        .manage(crate::folder::FolderWatcherState::new())
        .manage(tab_transfer::TabTransferBroker::new())
        // Replaces Tauri's own `asset:` handler so UNC hosts go through
        // `asset_protocol`'s trust rule. Registering the scheme here is what
        // suppresses the built-in one.
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
        // After single-instance, which ends a second launch in its setup, and
        // before window-state reads its file: adoption moves files, geometry
        // included, and only the instance that stays may touch them.
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("launch-session")
                .setup(|app, _| {
                    window_runtime::adopt_remembered_window(app);
                    Ok(())
                })
                .build(),
        )
        .plugin(tauri_plugin_prevent_default::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_runtime::geometry_flags())
                // No `map_label`: a secondary window keeps its label across
                // relaunches, so each one gets its own size and position back.
                // ponytail: entries of windows that never come back stay in
                // the plugin's file (~200 bytes each, no removal API); prune it
                // before the plugin loads if that ever matters.
                .build(),
        )
        .setup(|app| {
            app.manage(window_runtime::GeometrySaver::new(app.handle().clone()));
            let args: Vec<String> = std::env::args().collect();

            let mut window_builder = tauri::WebviewWindowBuilder::new(
                app,
                window_runtime::LAUNCH_LABEL,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Markpad")
            .inner_size(900.0, 650.0)
            .min_inner_size(400.0, 300.0)
            .visible(false)
            // Not `.focused(false)`: on a window built hidden it leaves WebView2
            // on Windows with no drop target, so every file dragged in is
            // refused (#768, tauri-apps/wry#1639). tao also keeps applying it
            // after the first show, so minimizing a maximized window flashes it
            // at its restored size (#776, tauri-apps/tao#1338). `show_window` skipping
            // `set_focus` is what keeps a cold start from stealing focus.
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
            commands::clipboard_read_file_list,
            commands::open_markdown_preview,
            commands::render_markdown,
            commands::markdown_semantic_spans,
            commands::markdown_outline,
            window_runtime::send_markdown_path,
            commands::read_file_content_checked,
            commands::canonicalize_path,
            commands::read_file_as_data_url,
            commands::save_file_content,
            commands::export_pdf_windows,
            commands::print_pdf,
            commands::is_win11,
            commands::open_file_folder,
            commands::is_launchable_path,
            commands::rename_file,
            commands::watch_file,
            window_runtime::unwatch_file,
            crate::folder::read_folder_entries,
            crate::folder::watch_folder,
            crate::folder::unwatch_folder,
            crate::folder::unwatch_all_folders,
            window_runtime::show_window,
            commands::save_theme,
            commands::get_system_fonts,
            commands::get_os_type,
            commands::self_update_supported,
            commands::fetch_vscode_theme,
            commands::get_saved_vscode_themes,
            commands::read_vscode_theme,
            commands::install_vscode_theme,
            commands::delete_vscode_theme,
            commands::save_image,
            commands::copy_file_to_img,
            commands::copy_file,
            commands::list_directory_contents,
            tab_transfer::stage_detached_tab,
            tab_transfer::claim_detached_tab,
            tab_transfer::complete_detached_tab,
            tab_transfer::cancel_detached_tab,
            window_runtime::create_transfer_window,
            window_runtime::set_window_meta,
            window_runtime::list_viewer_windows,
            window_runtime::is_window_tag_taken,
            window_runtime::offer_tab_to_window,
            window_runtime::focus_window,
            window_runtime::list_pinned_tags,
            window_runtime::save_pinned_tag,
            window_runtime::update_pinned_tag,
            window_runtime::rename_pinned_tag,
            window_runtime::remove_pinned_tag,
            window_runtime::save_window_state,
            window_runtime::load_window_state,
            window_runtime::clear_window_state,
            window_runtime::forget_window_state,
            window_runtime::reopen_remembered_windows,
            window_runtime::save_unsaved_recovery,
            window_runtime::claim_unsaved_recovery,
            window_runtime::clear_unsaved_recovery,
            window_runtime::set_quitting,
            window_runtime::keeps_unsaved_on_close,
            window_runtime::save_restore_progress,
            window_runtime::load_restore_progress,
            window_runtime::clear_restore_progress
        ])
        .on_window_event(window_runtime::handle_window_event)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                for url in urls {
                    if let Ok(path_buf) = url.to_file_path() {
                        window_runtime::deliver_opened_path(
                            _app_handle,
                            path_buf.to_string_lossy().to_string(),
                        );
                    }
                }
            }
        });
}
