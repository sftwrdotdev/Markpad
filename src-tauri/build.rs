#[allow(
    clippy::disallowed_methods,
    reason = "a build script reads Cargo's environment; the ban is on APPIMAGE at run time"
)]
fn main() {
    let mut windows = tauri_build::WindowsAttributes::new();
    // tauri-build puts its Common Controls v6 manifest into the app binary only.
    // A lib test binary that links the dialog code then fails to load on Windows
    // (STATUS_ENTRYPOINT_NOT_FOUND) before any test runs. The linker embeds the
    // same manifest into every target instead, and tauri-build adds no second
    // copy, which would fail the link (CVT1100).
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    if let Err(error) =
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
    {
        panic!("{error:#}");
    }
}
