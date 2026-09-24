//! Epicenter Tauri build script.
//!
//! The Whispering build links transcribe-cpp statically on macOS and
//! aarch64 Windows. Linux and x86_64 Windows use dynamic backends, so their
//! runtime libraries are staged for the final bundle here.

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

include!("src/command_names.rs");

fn main() {
    println!("cargo:rerun-if-env-changed=EPICENTER_SERVER_ORIGIN");
    bake_transcribe_rpath();
    stage_transcribe_runtime();

    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Epicenter's Tauri manifest");
}

/// Bake the rpaths the shared `libtranscribe` needs on Linux. Windows resolves
/// DLLs from the executable directory and macOS links transcribe-cpp statically.
fn bake_transcribe_rpath() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }

    // Bundles install the executable to /usr/bin and the staged libraries to
    // /usr/lib, so this is the only relative rpath a shipped build needs.
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");

    // Dev builds also need the transcribe-cpp build output before a bundle
    // layout exists.
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_LIB_DIR");
    if let Some(lib_dir) = env::var_os("DEP_TRANSCRIBE_CPP_LIB_DIR") {
        println!(
            "cargo:rustc-link-arg=-Wl,-rpath,{}",
            Path::new(&lib_dir).display()
        );
    }
}

/// Copy transcribe-cpp's shared libraries and backend modules into the stable
/// `transcribe-libs/` staging directory used by Tauri's platform bundles.
fn stage_transcribe_runtime() {
    for var in [
        "DEP_TRANSCRIBE_CPP_RUNTIME_DIR",
        "DEP_TRANSCRIBE_CPP_MODULE_DIR",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }

    let staging = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("transcribe-libs");

    // A missing runtime directory means this is a statically linked target.
    // Remove stale cross-target libraries once, but leave an already-empty
    // directory untouched so `tauri dev` does not rebuild in a watcher loop.
    let Some(runtime_dir) = env::var_os("DEP_TRANSCRIBE_CPP_RUNTIME_DIR") else {
        let has_stale_entries =
            fs::read_dir(&staging).is_ok_and(|mut entries| entries.next().is_some());
        if has_stale_entries {
            fs::remove_dir_all(&staging).expect("remove stale transcribe-libs staging directory");
            fs::create_dir_all(&staging).expect("create transcribe-libs staging directory");
        }
        return;
    };

    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).expect("create transcribe-libs staging directory");

    let mut dirs = BTreeSet::new();
    dirs.insert(PathBuf::from(runtime_dir));
    if let Some(module_dir) = env::var_os("DEP_TRANSCRIBE_CPP_MODULE_DIR") {
        dirs.insert(PathBuf::from(module_dir));
    }

    let mut copied = 0;
    for dir in &dirs {
        println!("cargo:rerun-if-changed={}", dir.display());
        copied += copy_libs(dir, &staging);
    }
    assert!(
        copied > 0,
        "no transcribe-cpp runtime libraries found under {dirs:?}; a dynamic-backends build must ship them"
    );
    println!("cargo:warning=Staged {copied} transcribe-cpp runtime library file(s)");
}

fn is_lib(name: &str) -> bool {
    name.ends_with(".dll")
        || name.ends_with(".dylib")
        || name.ends_with(".so")
        || name.contains(".so.")
}

fn copy_libs(src: &Path, dest: &Path) -> usize {
    let Ok(entries) = fs::read_dir(src) else {
        return 0;
    };
    let mut copied = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if is_lib(name) {
            fs::copy(&path, dest.join(name))
                .unwrap_or_else(|error| panic!("copy {} into staging: {error}", path.display()));
            copied += 1;
        }
    }
    copied
}
