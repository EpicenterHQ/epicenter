fn main() {
    // Declaring the app's commands makes each `allow-<command>` a permission
    // the window's capability grants (`capabilities/vocab.json`); the list is
    // `COMMANDS` in `src/lib.rs`, which a test checks against this one.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "folder_path",
        "choose_folder",
        "connection_keys",
        "set_connection_key",
        "account_state",
        "account_sign_in",
        "account_sign_out",
        "account_fetch",
        "account_fetch_cancel",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Vocab's Tauri manifest");
}
