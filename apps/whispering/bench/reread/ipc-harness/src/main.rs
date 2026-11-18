//! A bare Tauri app that times one folder re-read in a real webview: the
//! page calls `files_list` and `files_read_many` as `folder.read()` does
//! (the same `whispering_files` calls Whispering's shell makes), then the
//! same requests answered from memory, so the IPC alone is timed. It prints
//! a line per folder and quits. See `../README.md`.
//!
//! ```sh
//! cargo run --release -- <folder>...
//! ```

use std::path::Path;
use std::sync::Mutex;

use tauri::ipc::Response;

struct Cache(Mutex<Vec<u8>>);

/// The folders to time, from the command line.
#[tauri::command]
fn folders() -> Vec<String> {
    std::env::args().skip(1).collect()
}

/// What Whispering's `files_list` does.
#[tauri::command]
async fn files_list(folder: String, dir: String) -> Result<Vec<whispering_files::Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        whispering_files::list(Path::new(&folder), &dir).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// What Whispering's `files_read_many` does.
#[tauri::command]
async fn files_read_many(folder: String, paths: Vec<String>) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        whispering_files::read_many(Path::new(&folder), &paths)
            .map(Response::new)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The same paths in, `size` bytes out from memory: the IPC alone.
#[tauri::command]
fn echo(cache: tauri::State<'_, Cache>, paths: Vec<String>, size: usize) -> Response {
    drop(paths);
    let mut cached = cache
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cached.len() != size {
        *cached = vec![7u8; size];
    }
    Response::new(cached.clone())
}

#[tauri::command]
fn report(app: tauri::AppHandle, text: String) {
    println!("{text}");
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .manage(Cache(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
            folders,
            files_list,
            files_read_many,
            echo,
            report
        ])
        .run(tauri::generate_context!())
        .expect("the harness runs");
}
