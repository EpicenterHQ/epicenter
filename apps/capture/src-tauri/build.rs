fn main() {
    // Declaring the app's command makes `allow-choose-folder` and `allow-folder-path` the
    // permissions that let its window call them (`capabilities/capture.json`).
    let manifest = tauri_build::AppManifest::new().commands(&["choose_folder", "folder_path"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Capture's Tauri manifest");
}
