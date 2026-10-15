//! The desktop shell's side of a folder the page opens with its own engine.
//!
//! `Registry` maps the scopes a shell configured to windows, grants each
//! window its folder's directory under the folder's cross-process lock
//! (`lock`), and admits the page's reads (`page_reads`), changes
//! (`page_files`), and `git` runs (`page_git`) until shutdown. `paths` is
//! the path rule the folder engine shares. Nothing here depends on Tauri.

pub mod lock;
pub mod page_files;
pub mod page_git;
pub mod page_reads;
pub mod paths;
pub mod registry;
pub mod root;

#[cfg(test)]
mod registry_tests;
#[cfg(test)]
mod testing;
