//! The desktop shell's side of a folder the page opens with its own engine.
//!
//! `Directory` retains an existing canonical root for admitted file operations.
//! The Tauri plugin owns window bindings and their lifetime.
//! `storage` checks each save against the version its writer read, right
//! before the rename. `page_files` checks a path the shell changes on disk,
//! and `paths` is the path rule the folder engine shares. Nothing
//! here depends on Tauri. `library` computes and admits the fixed native app
//! defaults. The folder's Git runs in the `epicenter` CLI, never here (ADR-0559).

pub mod directory;
pub mod library;
pub mod page_files;
pub mod paths;
pub mod root;
pub mod storage;

#[cfg(test)]
mod directory_tests;
#[cfg(test)]
mod testing;
