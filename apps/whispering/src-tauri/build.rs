fn main() {
    // Declaring the app's own commands makes each `allow-<command>` the one
    // permission that lets a window call it (`capabilities/whispering.json`).
    let manifest = tauri_build::AppManifest::new().commands(&["recordings_list"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Whispering's Tauri manifest");
}
