//! Every recording in `recordings/`, read in one call: the page would
//! otherwise make one call per file, and a person can have 15,000.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

/// One recording: its note's text when it has one, and whether its audio
/// is there. A take that crashed before its note was written has audio and
/// no note; a note whose audio was deleted has no audio.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: String,
    pub note: Option<String>,
    pub audio: bool,
}

/// Each recording in `dir`, by id. A missing folder lists nothing.
pub fn list(dir: &Path) -> std::io::Result<Vec<Listed>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut by_id = BTreeMap::<String, Listed>::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some(id) = name.strip_suffix(".md") {
            let note = std::fs::read_to_string(entry.path())?;
            listed(&mut by_id, id).note = Some(note);
        } else if let Some(id) = name.strip_suffix(".webm") {
            listed(&mut by_id, id).audio = true;
        }
    }
    Ok(by_id.into_values().collect())
}

fn listed<'a>(by_id: &'a mut BTreeMap<String, Listed>, id: &str) -> &'a mut Listed {
    by_id.entry(id.to_string()).or_insert_with(|| Listed {
        id: id.to_string(),
        ..Listed::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recording_is_its_note_and_its_audio_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        std::fs::write(path.join("a.md"), "hello").unwrap();
        std::fs::write(path.join("a.webm"), [0u8]).unwrap();
        std::fs::write(path.join("b.webm"), [0u8]).unwrap();
        std::fs::write(path.join("c.md"), "only a note").unwrap();
        std::fs::write(path.join("c.md.tmp"), "half written").unwrap();
        std::fs::create_dir(path.join("d.md")).unwrap();

        let listed = list(path).unwrap();
        let summary: Vec<_> = listed
            .iter()
            .map(|r| (r.id.as_str(), r.note.as_deref(), r.audio))
            .collect();
        assert_eq!(
            summary,
            [
                ("a", Some("hello"), true),
                ("b", None, true),
                ("c", Some("only a note"), false),
            ]
        );
    }

    #[test]
    fn a_missing_folder_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list(&dir.path().join("recordings")).unwrap().is_empty());
    }
}
