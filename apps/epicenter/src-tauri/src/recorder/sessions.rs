//! One App document owns capture and a fixed app-local destination.
//! Stop commits immutable bytes before returning their saved blob ID.
use super::error::RecorderError;
use super::recorder::{FinalizedRecording, Recorder, Result};

use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(super) struct Sessions {
    documents: HashMap<String, (String, String)>,
    retired: HashSet<String>,
    files: HashMap<String, Finished>,
    requests: HashMap<(String, String), Option<String>>,
}

struct Finished {
    owner: String,
    session: String,
    recording: FinalizedRecording,
    stopped: StoppedRecording,
    published: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StoppedRecording {
    pub blob_id: String,
    pub duration_ms: u32,
    pub byte_length: u32,
}

impl Recorder {
    pub(super) fn discard_all_finished(&mut self) {
        for (_, file) in self.sessions.files.drain() {
            file.recording.staged.discard();
        }
    }
    pub fn register_session(&mut self, owner: &str, session: &str, app_id: &str) -> Result<()> {
        if session.is_empty() || session.len() > 128 || self.sessions.retired.contains(session) {
            return Err(RecorderError::not_recording("capture document has retired"));
        }
        crate::blobs::blobs_directory(
            std::path::Path::new(""),
            &crate::blobs::BlobDestination {
                app_id: app_id.into(),
            },
        )?;
        if let Some((current, current_app)) = self.sessions.documents.get(owner) {
            if current == session && current_app == app_id {
                return Ok(());
            }
            return Err(RecorderError::failed(
                "window already owns a capture document",
            ));
        }
        self.sessions
            .documents
            .insert(owner.into(), (session.into(), app_id.into()));
        Ok(())
    }

    pub fn require_session(&self, owner: &str, session: &str) -> Result<()> {
        if self
            .sessions
            .documents
            .get(owner)
            .map(|(session, _)| session.as_str())
            == Some(session)
        {
            Ok(())
        } else {
            Err(RecorderError::not_recording("capture document has retired"))
        }
    }

    pub fn session_app_id(&self, owner: &str, session: &str) -> Result<String> {
        self.require_session(owner, session)?;
        Ok(self.sessions.documents.get(owner).unwrap().1.clone())
    }

    pub fn close_session(&mut self, owner: &str, session: &str) {
        // A delayed close from an old document must not close its successor.
        self.sessions.retired.insert(session.into());
        if self.require_session(owner, session).is_ok() {
            self.close_document(owner);
        }
    }

    pub fn close_document(&mut self, owner: &str) {
        if let Some((session, _)) = self.sessions.documents.remove(owner) {
            self.sessions
                .requests
                .retain(|(document, _), _| document != &session);
            self.sessions.retired.insert(session);
        }
        self.cancel_owned_by(owner);
        let ids: Vec<_> = self
            .sessions
            .files
            .iter()
            .filter(|(_, file)| file.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.discard_file_owned_by(&id, owner);
        }
    }

    pub fn prepare_start(
        &mut self,
        owner: &str,
        session: &str,
        request: &str,
    ) -> Result<Option<super::recorder::HostRecording>> {
        self.require_session(owner, session)?;
        if request.is_empty() || request.len() > 128 {
            return Err(RecorderError::failed("invalid capture request identity"));
        }
        // Retrying a lost start returns the same live session and never opens
        // another microphone. A stopped session is explicitly disposed first.
        if let Some(id) = self
            .sessions
            .requests
            .get(&(session.into(), request.into()))
        {
            return self
                .current(owner)
                .filter(|current| Some(&current.audio_blob_id) == id.as_ref())
                .map(Some)
                .ok_or_else(|| RecorderError::not_recording("capture request has already ended"));
        }
        if self
            .sessions
            .files
            .values()
            .any(|file| file.owner == owner && !file.published)
        {
            return Err(RecorderError::failed(
                "retry Stop or cancel the unfinished save before starting another",
            ));
        }
        let old: Vec<_> = self
            .sessions
            .files
            .iter()
            .filter(|(_, file)| file.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in old {
            self.discard_file_owned_by(&id, owner);
        }
        Ok(None)
    }

    pub fn remember_start(&mut self, _owner: &str, session: &str, request: &str, id: &str) {
        self.sessions
            .requests
            .insert((session.into(), request.into()), Some(id.into()));
    }

    /// Recover this exact request or fence its absence before a delayed start
    /// handler can acquire the recorder lock. Never touch a successor or file.
    pub fn resolve_start(
        &mut self,
        owner: &str,
        session: &str,
        request: &str,
    ) -> Result<Option<super::recorder::HostRecording>> {
        self.require_session(owner, session)?;
        if request.is_empty() || request.len() > 128 {
            return Err(RecorderError::failed("invalid capture request identity"));
        }
        let key = (session.into(), request.into());
        if let Some(Some(id)) = self.sessions.requests.get(&key) {
            if let Some(current) = self
                .current(owner)
                .filter(|current| &current.audio_blob_id == id)
            {
                return Ok(Some(current));
            }
        }
        self.sessions.requests.insert(key, None);
        Ok(None)
    }

    pub fn stop_session(
        &mut self,
        owner: &str,
        session: &str,
        id: &str,
    ) -> Result<StoppedRecording> {
        self.require_session(owner, session)?;
        if !self.sessions.files.contains_key(id) {
            let recording = self.stop(id, owner).map_err(|error| match error {
                error @ RecorderError::NotRecording { .. } => error,
                error => RecorderError::CaptureLost {
                    message: error.to_string(),
                },
            })?;
            self.hold_finished(owner, session, id, recording)?;
        }
        let file = self.sessions.files.get_mut(id).unwrap();
        if file.owner != owner || file.session != session {
            return Err(RecorderError::not_recording(
                "recording belongs to another document",
            ));
        }
        if !file.published {
            file.recording.staged.commit("audio/wav")?;
            file.published = true;
        }
        Ok(file.stopped.clone())
    }

    fn hold_finished(
        &mut self,
        owner: &str,
        session: &str,
        id: &str,
        recording: FinalizedRecording,
    ) -> Result<StoppedRecording> {
        let byte_length = match std::fs::metadata(recording.staged.data_path())
            .map_err(|error| format!("stat finished capture: {error}"))
            .and_then(|metadata| {
                u32::try_from(metadata.len())
                    .map_err(|_| "finished capture exceeds the RIFF bound".into())
            }) {
            Ok(length) => length,
            Err(message) => {
                recording.staged.discard();
                return Err(RecorderError::CaptureLost { message });
            }
        };
        let stopped = StoppedRecording {
            blob_id: id.into(),
            duration_ms: recording.duration_ms,
            byte_length,
        };
        self.sessions.files.insert(
            id.into(),
            Finished {
                owner: owner.into(),
                session: session.into(),
                recording,
                stopped: stopped.clone(),
                published: false,
            },
        );
        Ok(stopped)
    }

    pub fn cancel_session(&mut self, owner: &str, session: &str, id: &str) -> Result<()> {
        self.require_session(owner, session)?;
        if self.holds(id) {
            self.cancel(id, owner)?;
        }
        self.discard_file_owned_by(id, owner);
        Ok(())
    }

    fn discard_file_owned_by(&mut self, id: &str, owner: &str) {
        if self
            .sessions
            .files
            .get(id)
            .is_some_and(|file| file.owner == owner)
        {
            let file = self.sessions.files.remove(id).unwrap();
            // The staging path never changes on publication. A rename moved
            // the bytes out of it, so cleanup cannot delete a saved attachment.
            file.recording.staged.discard();
        }
    }
}
