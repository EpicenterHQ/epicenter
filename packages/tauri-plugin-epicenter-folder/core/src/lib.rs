//! One native owner per Epicenter folder.
//!
//! `FolderOwner` holds a canonical root: it publishes files, observes and
//! commits Git history, and tells every listener what changed. `Registry`
//! maps the scopes a shell configured to owners and decides which window may
//! use which scope. Nothing here depends on Tauri.

pub mod download;
pub mod files;
pub mod git;
pub mod history;
pub mod incoming;
pub mod kv_merge;
pub mod lock;
pub mod merge;
pub mod messages;
pub mod owner;
pub mod page_files;
pub mod page_git;
pub mod paths;
pub mod registry;
mod runner;
pub mod transport;

#[cfg(test)]
mod admission_tests;
#[cfg(test)]
mod history_tests;
#[cfg(test)]
mod incoming_tests;
#[cfg(test)]
mod merge_tests;
#[cfg(test)]
mod publication_tests;
#[cfg(test)]
mod registry_tests;
#[cfg(test)]
mod testing;
#[cfg(test)]
mod transport_tests;
