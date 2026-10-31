fn main() {
    // The shell's commands, from `epicenter-standalone`: declaring them makes
    // `allow-choose-folder` and `allow-folder-path` the permissions that let
    // the window call them (`capabilities/honeycrisp.json`).
    let manifest = tauri_build::AppManifest::new().commands(&["choose_folder", "folder_path"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Honeycrisp's Tauri manifest");
}
