//! How bytes reach Whispering's folder on the desktop (ADR-0894), shared by
//! Whispering's shell and its recorder plugin so both keep one rule.
//!
//! - `path.rs`: the plain-name path rule, and where a path that passes it
//!   is in a folder, refusing a symbolic link on the way.
//! - `beside.rs`: a file is replaced through a temporary file beside it,
//!   and what a crash left of one is removed when the folder opens
//!   (ADR-0962).
//! - `ops.rs`: `read`, `read_many`, `write`, `list`, and `remove`, the
//!   operations the page's `Files` makes.
//! - `change.rs`: "Change…", which moves the recordings into an empty
//!   folder or opens a Whispering folder, and never merges.
//! - `git.rs`: whether the folder is in a Git repository that keeps audio
//!   through Git LFS.
//!
//! None of it knows what a file means: Markdown is read and written by the
//! page. Whether a folder is one the app may touch is the caller's to check
//! (the shell asks `tauri-plugin-fs`'s scope); this crate has no Tauri.

mod beside;
mod change;
mod error;
mod git;
mod ops;
mod path;

pub use beside::remove_leftovers;
pub use change::{change_folder, Changed};
pub use error::FilesError;
pub use git::{folder_git, FolderGit};
pub use ops::{list, read, read_many, remove, write, Entry};
pub use path::{is_bare_name, make_parents, resolve, resolve_dir};
