fn main() {
    // Declaring the shell's own commands is what makes their `allow-<command>`
    // permissions exist for the runtime capability to grant.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["flush_done"])),
    )
    .expect("failed to build Whispering's Tauri manifest");
}
