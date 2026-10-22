//! The desktop shell's side of a folder the page opens with its own engine.
//!
//! `Directory` retains an existing canonical root for admitted file operations.
//! The Tauri plugin owns window bindings and their lifetime.
//! Each publication holds the folder's save lock (`lock`) across its check
//! and change, shared by native windows and other participating processes. `page_files` checks a path the shell changes
//! on disk, and `paths` is the path rule the folder engine shares. Nothing
//! here depends on Tauri. `library` computes and admits the fixed native app
//! defaults, and `navigation` is the machine's remembered folder list. The
//! folder's Git runs in the `epicenter` CLI, never here (ADR-0559).

pub mod directory;
pub mod library;
pub mod lock;
pub mod navigation;
pub mod page_files;
pub mod paths;
pub mod root;
pub mod storage;

#[cfg(test)]
mod directory_tests;
#[cfg(test)]
mod testing;
