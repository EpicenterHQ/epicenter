fn main() {
    // Declaring the shell's command makes `allow-open-in-epicenter` the one
    // permission that lets a window call it (`capabilities/todos.json`).
    let manifest = tauri_build::AppManifest::new().commands(&["open_in_epicenter"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Todos's Tauri manifest");
}
