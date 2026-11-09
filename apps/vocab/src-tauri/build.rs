fn main() {
    // Declaring the app's own commands makes each `allow-<command>` the one
    // permission that lets a window call it (`capabilities/vocab.json`).
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Vocab's Tauri manifest");
}

include!("src/command_names.rs");
