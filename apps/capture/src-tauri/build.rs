fn main() {
    // Declaring the app's command makes `allow-choose-folder` the
    // permission that lets its window call it (`capabilities/capture.json`).
    let manifest = tauri_build::AppManifest::new().commands(&["choose_folder"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Capture's Tauri manifest");
}
