//! The records the Epicenter folder keeps, one per synced folder, at
//! `.epicenter/synced/<folder-id>.json` (ADR-0822). Only Epicenter writes
//! them; a standalone app reads the one that names its Data root to show
//! what is synced (`data_record`), and never writes one.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use epicenter_folder_core::identity::{proves, FolderIdentity};
use serde::{Deserialize, Serialize};
use specta::Type;

/// What Epicenter last agreed with the server for one folder: which server
/// folder it is, its name, the identity of the directory that agreed it,
/// the commit agreed, and each file's Git blob id then.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FolderRecord {
    pub folder: String,
    pub name: String,
    pub inode: String,
    pub birthtime: Option<String>,
    pub commit: Option<String>,
    /// Folder-relative path to Git blob id.
    pub files: BTreeMap<String, String>,
}

impl FolderRecord {
    /// The identity of the directory that agreed it.
    fn identity(&self) -> FolderIdentity {
        FolderIdentity {
            inode: self.inode.clone(),
            birthtime: self.birthtime.clone(),
        }
    }
}

/// The record in the records directory `records` that proves `identity`
/// (`identity::proves`: the same inode and the same real birth time), by
/// file name order when more than one would. A file that is not a record,
/// does not parse, or is a link is passed over; no records is none.
pub fn proving(records: &Path, identity: &FolderIdentity) -> Option<FolderRecord> {
    let mut names: Vec<_> = fs::read_dir(records)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.file_name())
        .filter(|name| name.to_string_lossy().ends_with(".json"))
        .collect();
    names.sort();
    names.into_iter().find_map(|name| {
        let text = fs::read_to_string(records.join(name)).ok()?;
        let record: FolderRecord = serde_json::from_str(&text).ok()?;
        proves(&record.identity(), identity).then_some(record)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(inode: &str, birthtime: Option<&str>) -> FolderIdentity {
        FolderIdentity {
            inode: inode.to_string(),
            birthtime: birthtime.map(str::to_string),
        }
    }

    #[test]
    fn only_a_record_that_proves_the_identity_answers() {
        let temp = tempfile::tempdir().unwrap();
        let records = temp.path().join("synced");
        assert_eq!(proving(&records, &identity("1", Some("2"))), None);
        fs::create_dir(&records).unwrap();
        let record = serde_json::json!({
            "folder": "f_1",
            "name": "Recipes",
            "inode": "12",
            "birthtime": "1700000000123456789",
            "commit": "abc",
            "files": { "a.md": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" },
            "later": "a field a newer Epicenter writes",
        });
        fs::write(records.join("f_1.json"), record.to_string()).unwrap();
        let unborn = serde_json::json!({
            "folder": "f_2", "name": "Other", "inode": "13", "birthtime": null,
            "commit": null, "files": {},
        });
        fs::write(records.join("f_2.json"), unborn.to_string()).unwrap();
        fs::write(records.join("broken.json"), "{").unwrap();
        fs::write(records.join("notes.txt"), record.to_string()).unwrap();

        let found = proving(&records, &identity("12", Some("1700000000123456789"))).unwrap();
        assert_eq!(found.folder, "f_1");
        assert_eq!(found.commit.as_deref(), Some("abc"));
        assert_eq!(found.files.len(), 1);
        assert_eq!(
            proving(&records, &identity("12", Some("1700000000123456788"))),
            None
        );
        assert_eq!(proving(&records, &identity("12", None)), None);
        // A record with no birth time proves nothing, whatever its inode.
        assert_eq!(proving(&records, &identity("13", None)), None);
    }
}
