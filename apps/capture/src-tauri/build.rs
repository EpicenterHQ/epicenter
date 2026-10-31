fn main() {
    // Declaring the app's commands makes `allow-open-data-folder` and
    // `allow-choose-data-folder` the permissions that let its window call them (`capabilities/capture.json`).
    let manifest =
        tauri_build::AppManifest::new().commands(&["open_data_folder", "choose_data_folder"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Capture's Tauri manifest");
}
