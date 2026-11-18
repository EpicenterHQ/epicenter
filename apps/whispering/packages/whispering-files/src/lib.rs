//! How bytes reach Whispering's folder on the desktop (ADR-0894), shared by
//! Whispering's shell and its recorder plugin so both keep one rule.
//!
//! - [`path`]: the plain-name path rule, and where a path that passes it is
//!   in a folder, refusing a symbolic link on the way.
//! - [`beside`]: a file is replaced through a temporary file beside it, and
//!   what a crash left of one is removed when the folder opens (ADR-0962).
//! - [`ops`]: `read`, `read_many`, `write`, `list`, and `remove`, the
//!   operations the page's `Files` makes.
//! - [`change`]: "Change…", which moves the recordings into an empty folder
//!   or opens a Whispering folder, and never merges.
//! - [`git`]: whether the folder is in a Git repository that keeps audio
//!   through Git LFS.
//!
//! None of it knows what a file means: Markdown is read and written by the
//! page. Whether a folder is one the app may touch is the caller's to check
//! (the shell asks `tauri-plugin-fs`'s scope); this crate has no Tauri.

pub mod beside;
pub mod change;
pub mod error;
pub mod git;
pub mod ops;
pub mod path;

pub use beside::remove_leftovers;
pub use change::{change_folder, Changed};
pub use error::{FilesError, Result};
pub use git::{folder_git, FolderGit};
pub use ops::{list, read, read_many, remove, write, Entry, MISSING};
pub use path::{
    dir_problem, file_problem, is_bare_name, is_file_name, make_parents, resolve, resolve_dir,
};
