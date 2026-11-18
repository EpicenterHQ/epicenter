//! Generate one permission per command, with no default grant.
include!("src/command_names.rs");

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
