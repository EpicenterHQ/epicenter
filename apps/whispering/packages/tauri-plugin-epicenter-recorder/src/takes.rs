//! Where a take is recorded, where it is placed, and how one a quit or a
//! crash cut off gets there (ADR-0894).
//!
//! A take is recorded into `<appLocalDataDir>/local/recording/<id>.webm`,
//! outside the folder, so a listing, a file syncer, or a home's checkpoint
//! never sees it grow. Stop finishes it there and places it at
//! `<folder>/recordings/<id>.webm` with the shared place step in its
//! never-replace mode (`whispering_files::place_into`). A take that cannot
//! be placed stays in `local/recording/`, and `recover` places it later.
//!
//! `recover` finishes every take a quit or a crash left in
//! `local/recording/` from its whole seconds (`webm::finish_cut_off`) and
//! places it in the folder the page names. A take whose audio path is taken
//! stays, and is answered among `unplaced` on every run until a person
//! moves one of the two. A leftover that holds no whole second holds no
//! audio, and is deleted.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use whispering_files::{is_bare_name, place_into, FilesError, Mode};

use crate::webm::{finish_cut_off, CutOff, OPUS_RATE};

/// The take of the recording `id` in the takes directory `takes`.
pub fn take_path(takes: &Path, id: &str) -> PathBuf {
    takes.join(format!("{id}.webm"))
}

/// The folder-relative path the recording `id`'s audio is placed at.
pub fn audio_path(id: &str) -> String {
    format!("recordings/{id}.webm")
}

/// Refuse an id that is not one plain name with no extension.
pub fn check_id(id: &str) -> Result<(), String> {
    if is_bare_name(id) {
        Ok(())
    } else {
        Err(format!(
            "{id:?} is not a recording id: one or more of A-Z, a-z, 0-9, - and _"
        ))
    }
}

/// Place the finished take at `take` into `folder` as the recording `id`'s
/// audio, never over a file there. The take stays wherever this fails.
pub fn place_take(take: &Path, folder: &Path, id: &str) -> Result<(), FilesError> {
    place_into(take, folder, &audio_path(id), Mode::New).map(|_| ())
}

/// What `recover` did with the takes a quit or a crash left.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    /// Each take finished and placed at `recordings/<id>.webm`, by id.
    pub recovered: Vec<RecoveredRecording>,
    /// Each take left in `local/recording/`, by id: another file is at its
    /// audio path, or it could not be finished or placed. It stays until it
    /// is placed or a person moves it.
    pub unplaced: Vec<UnplacedTake>,
}

/// A take `recover` placed: its recording's id, and how long it plays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredRecording {
    pub id: String,
    /// How long it plays, to the nearest millisecond, as its file states.
    pub duration_ms: u32,
}

/// A take `recover` did not place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnplacedTake {
    pub id: String,
    /// The take's absolute path, in `local/recording/`.
    pub take: String,
}

/// Every take in `takes`: each `<id>.webm` regular file whose id passes
/// [`check_id`], by id. A missing directory holds none.
fn takes_in(takes: &Path) -> io::Result<Vec<(String, PathBuf)>> {
    let entries = match fs::read_dir(takes) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut found = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".webm") else {
            continue;
        };
        if check_id(id).is_err() {
            continue;
        }
        let path = entry.path();
        if !fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
            continue;
        }
        found.push((id.to_string(), path));
    }
    found.sort();
    Ok(found)
}

/// Finish and place every take in `takes` that a quit or a crash left,
/// into `folder`, skipping the one `held` names: the take a live recording
/// is still writing. `held` is asked about each take right before it is
/// touched, so a recording that started after this began is never taken
/// for a leftover. Running it again places nothing more.
pub fn recover(
    takes: &Path,
    folder: &Path,
    held: impl Fn(&Path) -> bool,
) -> Result<Recovery, FilesError> {
    let mut recovery = Recovery::default();
    let found = takes_in(takes).map_err(|error| FilesError::from_io(takes.display(), &error))?;
    for (id, take) in found {
        if held(&take) {
            continue;
        }
        let unplaced = |recovery: &mut Recovery| {
            recovery.unplaced.push(UnplacedTake {
                id: id.clone(),
                take: take.to_string_lossy().into_owned(),
            })
        };
        let played = match finish_cut_off(&take) {
            Ok(CutOff::Finished { played } | CutOff::Recovered { played }) => played,
            Ok(CutOff::Empty) => {
                log::info!("Removed the take of {id}: no audio reached it");
                if let Err(error) = fs::remove_file(&take) {
                    if error.kind() != io::ErrorKind::NotFound {
                        log::warn!("{} was not removed: {error}", take.display());
                    }
                }
                continue;
            }
            // Stopped and placed since it was listed.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                log::warn!("Could not finish the take of {id}: {error}");
                unplaced(&mut recovery);
                continue;
            }
        };
        match place_take(&take, folder, &id) {
            Ok(()) => {
                log::info!("Recovered the take of {id}");
                recovery.recovered.push(RecoveredRecording {
                    id: id.clone(),
                    duration_ms: ((played * 1_000 + OPUS_RATE / 2) / OPUS_RATE) as u32,
                });
            }
            Err(error) => {
                log::warn!("Kept the take of {id} at {}: {error}", take.display());
                unplaced(&mut recovery);
            }
        }
    }
    Ok(recovery)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opus::OpusRecording;

    /// A recording cut off after `seconds`, rounded to whole 20 ms packets,
    /// written at `path` and left as a crash leaves it.
    fn cut_off(path: &Path, seconds: f64) {
        let mut recording = OpusRecording::new(fs::File::create(path).unwrap()).unwrap();
        let samples = (seconds * 16_000.0) as usize / 320 * 320;
        recording.write(&vec![1_000i16; samples]).unwrap();
    }

    /// What a cut-off recording of `seconds` plays once recovered, in
    /// milliseconds: its whole seconds before the one held, less the
    /// encoder's 6.5 ms delay.
    fn kept_ms(seconds: f64) -> u32 {
        let packets = (seconds * 50.0) as u64;
        let whole = (packets - 1) / 50 * 50;
        (((whole * 960 - 312) * 1_000 + 24_000) / 48_000) as u32
    }

    fn recovered(id: &str, duration_ms: u32) -> RecoveredRecording {
        RecoveredRecording {
            id: id.to_string(),
            duration_ms,
        }
    }

    /// The samples the transcription decoder reads from the file at `path`.
    fn decoded(path: &Path) -> usize {
        tauri_plugin_epicenter_transcription::audio::decode_to_pcm16k_mono(&fs::read(path).unwrap())
            .unwrap()
            .len()
    }

    struct Dirs {
        _temp: tempfile::TempDir,
        takes: PathBuf,
        folder: PathBuf,
    }

    fn dirs() -> Dirs {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let (takes, folder) = (root.join("local/recording"), root.join("data"));
        fs::create_dir_all(&takes).unwrap();
        fs::create_dir_all(&folder).unwrap();
        Dirs {
            _temp: temp,
            takes,
            folder,
        }
    }

    #[test]
    fn an_id_is_one_plain_name() {
        for id in ["k3x9a2f8", "2026-10-30T22-41-05-123Z-k3x9a2f8"] {
            assert_eq!(check_id(id), Ok(()), "{id}");
        }
        for id in ["", "a.webm", "../a", "a/b", ".a", "a b"] {
            assert!(check_id(id).is_err(), "{id:?}");
        }
    }

    #[test]
    fn recover_finishes_and_places_what_a_cut_left_and_nothing_else() {
        let Dirs { takes, folder, .. } = &dirs();
        let (a, b, live) = (
            take_path(takes, "a"),
            take_path(takes, "b"),
            take_path(takes, "live"),
        );
        cut_off(&a, 2.5);
        cut_off(&b, 3.1);
        cut_off(&live, 2.5);
        fs::write(takes.join("notes.txt"), b"not a take").unwrap();
        fs::write(takes.join(".x.webm"), b"hidden").unwrap();
        let live_bytes = fs::read(&live).unwrap();

        let recovery = recover(takes, folder, |path| path == live).unwrap();
        assert_eq!(
            recovery.recovered,
            [recovered("a", kept_ms(2.5)), recovered("b", kept_ms(3.1))]
        );
        assert!(recovery.unplaced.is_empty());
        assert_eq!(kept_ms(2.5), 1_994);
        assert_eq!(decoded(&folder.join("recordings/a.webm")), 2 * 16_000 - 104);
        assert!(!a.exists(), "moved, not copied");
        assert!(!b.exists());
        assert_eq!(
            fs::read(&live).unwrap(),
            live_bytes,
            "a live take is its writer's"
        );
        assert_eq!(fs::read(takes.join("notes.txt")).unwrap(), b"not a take");

        assert_eq!(
            recover(takes, folder, |path| path == live).unwrap(),
            Recovery::default()
        );
        assert_eq!(
            recover(&takes.join("missing"), folder, |_| false).unwrap(),
            Recovery::default()
        );
    }

    /// A take whose audio path holds another file is never deleted and never
    /// placed beside it: it stays, finished, and is answered with where it
    /// is, on every run. One that holds no whole second holds no audio, and
    /// is deleted.
    #[test]
    fn a_take_is_deleted_only_when_it_holds_no_audio() {
        let Dirs { takes, folder, .. } = &dirs();
        let taken = take_path(takes, "taken");
        cut_off(&taken, 2.5);
        fs::create_dir_all(folder.join("recordings")).unwrap();
        fs::write(folder.join("recordings/taken.webm"), b"theirs").unwrap();
        let empty = take_path(takes, "empty");
        cut_off(&empty, 0.5);

        let unplaced = UnplacedTake {
            id: "taken".to_string(),
            take: taken.to_string_lossy().into_owned(),
        };
        for _ in 0..2 {
            assert_eq!(
                recover(takes, folder, |_| false).unwrap(),
                Recovery {
                    recovered: vec![],
                    unplaced: vec![unplaced.clone()],
                }
            );
            assert_eq!(decoded(&taken), 2 * 16_000 - 104, "kept, and finished");
            assert_eq!(
                fs::read(folder.join("recordings/taken.webm")).unwrap(),
                b"theirs"
            );
        }
        assert!(!empty.exists());
        assert!(!folder.join("recordings/empty.webm").exists());
    }

    #[cfg(unix)]
    #[test]
    fn recover_never_follows_a_link() {
        let Dirs { takes, folder, .. } = &dirs();
        let outside = takes.parent().unwrap().join("outside.webm");
        cut_off(&outside, 2.5);
        let bytes = fs::read(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, take_path(takes, "x")).unwrap();
        assert_eq!(
            recover(takes, folder, |_| false).unwrap(),
            Recovery::default()
        );
        assert_eq!(fs::read(&outside).unwrap(), bytes);
        assert!(!folder.join("recordings/x.webm").exists());

        // A link where the recordings directory would be refuses the place.
        cut_off(&take_path(takes, "y"), 2.5);
        let elsewhere = takes.parent().unwrap().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, folder.join("recordings")).unwrap();
        let recovery = recover(takes, folder, |_| false).unwrap();
        assert_eq!(recovery.unplaced.len(), 1);
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    }
}
