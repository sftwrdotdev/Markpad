//! Markpad's Rust backend.
//!
//! Four modules that used to share one file, plus the three that already had
//! their own: `fs_safety` (durable writes, file identity, text decoding),
//! `markdown` (the render pipeline), `commands` (what the frontend can
//! `invoke`) and `app` (the Tauri builder).

mod app;
mod asset_protocol;
mod commands;
mod error;
mod fs_safety;
mod markdown;
mod semantic;
mod tab_transfer;
mod window_runtime;

pub use app::run;
