fn main() {
    tauri_build::try_build(tauri_build::Attributes::new())
        .expect("failed to build Capture's Tauri manifest");
}
