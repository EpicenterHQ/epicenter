//! The desktop shell's side of a folder the page opens with its own engine.
//!
//! `Registry` maps the scopes a shell configured to windows, grants each
//! window its folder's directory under the folder's cross-process lock
//! (`lock`), and admits the page's storage calls (`storage`) until
//! shutdown. `page_files` checks a path the shell changes on disk, and
//! `paths` is the path rule the folder engine shares. Nothing here depends
//! on Tauri. The folder's Git runs in the
//! `epicenter` CLI, never here (ADR-0559).

pub mod lock;
pub mod page_files;
pub mod paths;
pub mod registry;
pub mod root;
pub mod storage;

#[cfg(test)]
mod registry_tests;
#[cfg(test)]
mod testing;
