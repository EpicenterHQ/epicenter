//! The plugin owns one generated command contract and no default grant.

#[test]
fn bindings_match_the_registered_commands() {
    let generated =
        std::env::temp_dir().join(format!("transcription-bindings-{}.ts", std::process::id()));
    crate::specta_builder::<tauri::Wry>()
        .export(specta_typescript::Typescript::default(), &generated)
        .expect("export transcription bindings");
    let fresh = std::fs::read_to_string(&generated).unwrap();
    let fresh = fresh
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    let fresh = format!("{}\n", fresh.trim_end());
    let _ = std::fs::remove_file(generated);
    let committed =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("guest-js/bindings.gen.ts");
    if std::env::var_os("TRANSCRIPTION_WRITE_BINDINGS").is_some() {
        std::fs::write(&committed, &fresh).unwrap();
    }
    assert_eq!(std::fs::read_to_string(committed).unwrap(), fresh,
        "run TRANSCRIPTION_WRITE_BINDINGS=1 cargo test -p tauri-plugin-epicenter-transcription bindings");
    for command in crate::COMMANDS {
        assert!(
            fresh.contains(&format!("\"plugin:epicenter-transcription|{command}\"")),
            "{command}"
        );
    }
    assert!(!std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("permissions/default.toml")
        .exists());
}
