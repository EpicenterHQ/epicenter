// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vocab_lib::run();
}
