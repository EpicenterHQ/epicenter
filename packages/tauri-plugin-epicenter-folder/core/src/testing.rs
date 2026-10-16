//! Disposable directories for tests, with this machine's Git configuration
//! kept out of them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;

static NEXT: AtomicU64 = AtomicU64::new(0);
static ENVIRONMENT: Once = Once::new();

/// This machine's Git configuration must not change outcomes.
fn isolate_git() {
    ENVIRONMENT.call_once(|| {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    });
}

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        isolate_git();
        let path = std::env::temp_dir().join(format!(
            "epicenter-folder-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create a temporary directory");
        Self(std::fs::canonicalize(&path).expect("canonical temporary directory"))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// A new empty directory inside this one.
    pub fn folder(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::create_dir_all(&path).expect("create a folder");
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
