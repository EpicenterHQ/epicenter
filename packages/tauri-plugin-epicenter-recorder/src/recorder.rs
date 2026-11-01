//! CPAL recorder built around a two-thread pipeline.
//!
//! ```text
//! cpal callback thread            writer worker thread
//! ┌──────────────────────┐  chan  ┌──────────────────────┐
//! │ build_input_stream   │ ─────▶ │ run_capture          │
//! │  - downmix to mono   │ bound  │  - convert to 16 kHz │
//! │  - convert to PCM16  │   ed   │  - encode to Opus    │
//! │  - try_send, or drop │        │  - write WebM        │
//! │                      │        │  - send mic level    │
//! └──────────────────────┘        └──────────────────────┘
//! ```
//!
//! The cpal callback never blocks and never touches a file: it downmixes to
//! mono, converts to PCM16, and hands the chunk to a **bounded** channel with
//! `try_send`. A full channel drops the chunk, which is the only outcome that
//! keeps a stalled disk from stalling the audio thread.
//!
//! The worker encodes those chunks to Opus as they arrive and writes them
//! into the recording's WebM (`opus`, `webm`), so memory is flat in the
//! recording's length rather than proportional to it. An hour-long meeting
//! costs the same resident audio as a four-second dictation: one bounded
//! queue and the second of packets the writer holds. That is the whole
//! reason this path exists, and it is why there is no separate long-form
//! mode for an application to select.
//!
//! # A recording is a file from the first sample
//!
//! The WebM is created in the folder's `.epicenter/recordings` when the
//! recording starts, and each second of it is written there whole as soon as
//! it is encoded (ADR-0543), so a process that ends mid-recording leaves
//! every second but the last behind a head that does not yet state its
//! length; `staging::recover` finishes such a file the next time the folder
//! opens. Once capture has begun, nothing here deletes a file that holds
//! audio.
//!
//! `stop` finishes the file in place, which is the same few milliseconds
//! for a recording of any length (the last second, the Cues, and its
//! length), places it at its path (`staging::place_recording`), and answers
//! where it is. Exit and a page that leaves do the same.
//!
//! # The microphone keeps its rate; the file is 16 kHz
//!
//! The microphone is opened at the rate and format it already runs at
//! ([`input_config`]). Asking a macOS device for another rate sets that
//! device's nominal rate for every process using it, and it stays set after
//! the stream closes, so a call in progress on the same microphone would go
//! silent. The writer converts each chunk to 16 kHz mono PCM16 instead
//! ([`crate::rate`]): the rate local transcription reads, and the rate the
//! encoder is tuned for in voice.
//!
//! # One recorder, owned by the window that started it
//!
//! There is exactly one recorder for the whole host, and at most one
//! recording in flight. A recording is addressed by the id the host minted
//! for it and is owned by the window label that started it. Every lifecycle
//! method takes both, so an application can only ever stop the recording it
//! actually started: a competing `start` is refused with
//! [`RecorderError::Busy`] rather than silently displacing the live one.
//!
//! A window whose page reloads or closes can no longer stop its recording, so
//! the host finalizes it for that window ([`Recorder::finish_owned_by`]): the
//! audio is kept, and the slot is free for the next page.
//!
//! # An ended recording is still the owner's to claim
//!
//! Capture can stop without anyone asking: the microphone is unplugged, a
//! permission is withdrawn, the stream dies, the disk fills. That releases
//! the *device*, not the *recording*. [`Recorder::end_capture`] marks the
//! recording ended, drops the cpal stream, and leaves everything else
//! exactly where it was: the slot stays occupied and the file stays as
//! capture left it.
//!
//! That is the whole interruption design. There is no pending-interruption
//! inbox, no acknowledgement, no restore call, and no second channel that pushes
//! audio at the owner. `stop` remains the one path that finalizes a file,
//! whether or not capture is still running when it is called; nothing deletes
//! a captured one. A competing `start` stays [`Busy`] until
//! the owner resolves it, or until the owning window's page is gone.
//!
//! [`Busy`]: RecorderError::Busy
//!
//! The label identifies a *window*, not an application: a window may change
//! which page it is showing. Ownership here exists for resource correctness,
//! not isolation. Labels are assigned by the shell and cannot be supplied by
//! the frontend, which is what makes them usable at all.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream};
use log::{debug, error, info, warn};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

use crate::ended::{EndedReason, RecordingSignal};
use crate::error::RecorderError;
use crate::meter::Meter;
use crate::opus::{OpusRecording, TO_48K};
use crate::rate::RateConverter;
use crate::webm::{finish_cut_off, CutOff, Storage};

/// Recorder result type. Errors cross the IPC boundary as the internally
/// tagged `RecorderError` enum (`{ name, message }`) so the JS side switches
/// on `error.name` instead of matching message text.
pub type Result<T> = std::result::Result<T, RecorderError>;

/// The rate every recording is written at, whatever rate its microphone runs
/// at: the rate local transcription reads, so it reads a recording without
/// converting it again.
pub(crate) const RECORDING_RATE: u32 = 16_000;

/// How many callback chunks may wait for the writer.
///
/// cpal's default input buffer is on the order of 10 ms per callback across
/// backends, so this is roughly two seconds of backlog: long enough to absorb a
/// disk hiccup, short enough that the memory is a rounding error (a few hundred
/// kilobytes even with unusually large buffers) and bounded no matter how long
/// the recording runs. Deliberately private. It is a tuning constant, not a
/// promise to any caller, and no application can act on it.
const CAPTURE_QUEUE_CHUNKS: usize = 200;

/// How often a backlogged writer may report dropped chunks.
const DROP_REPORT_INTERVAL: Duration = Duration::from_secs(1);

/// The least time between two levels sent to a page.
///
/// The owner hears its microphone's level over the channel its page passed to
/// `start`, which reaches that page alone; the JS side never sees the PCM, so
/// the level has to originate here. An application that draws the meter
/// somewhere else too forwards it from there.
///
/// A level is sent with the first audio callback after this much time, so at
/// most twenty a second, and fewer when the device's callbacks are long. That
/// is smooth for a meter and keeps the channel off the IPC hot path (per
/// Tauri's guidance to throttle high-frequency messages). Levels between
/// sends are averaged, not dropped, so a brief loud transient still registers.
const MIC_LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(50);

/// The microphone's loudness since the last level was sent: the root mean
/// square of every sample in between, so a brief loud transient still
/// registers. A recording and a meter both send it, at most once per
/// [`MIC_LEVEL_EMIT_INTERVAL`].
pub(crate) struct Level {
    sum_of_squares: f64,
    samples: usize,
    last_sent: Instant,
}

impl Level {
    pub(crate) fn new() -> Self {
        Self {
            sum_of_squares: 0.0,
            samples: 0,
            last_sent: Instant::now(),
        }
    }

    pub(crate) fn add(&mut self, samples: &[i16]) {
        for &sample in samples {
            let normalized = sample as f64 / 32_768.0;
            self.sum_of_squares += normalized * normalized;
        }
        self.samples += samples.len();
    }

    /// The level to send at `now`, from 0 to 1, if one is due and anything
    /// was heard since the last; taking it starts the next interval.
    pub(crate) fn take(&mut self, now: Instant) -> Option<f32> {
        if self.samples == 0 || now.duration_since(self.last_sent) < MIC_LEVEL_EMIT_INTERVAL {
            return None;
        }
        let rms = (self.sum_of_squares / self.samples as f64).sqrt() as f32;
        self.sum_of_squares = 0.0;
        self.samples = 0;
        self.last_sent = now;
        Some(rms)
    }
}

/// Worker-thread command channel.
///
/// `Stop` asks the worker to finalize the file, which ends the worker.
/// `EndCapture` does not: it tells the worker its capture is over so it can
/// release the microphone and wait, still holding the file, for the owner to
/// stop it.
#[derive(Debug)]
enum RecorderCmd {
    Stop(mpsc::Sender<Result<FinishedRecording>>),
    EndCapture,
}

/// The recording one capture is writing, at its place in the folder's
/// `.epicenter/recordings`.
///
/// Owned entirely by the worker thread, which is what lets the writer stay
/// unsynchronized: nothing else in this process writes the file, so there is
/// no lock between the audio path and the bytes. `S` is the file, or in a
/// test one whose disk fills.
struct CaptureFile<S: Storage = File> {
    path: PathBuf,
    /// `None` only after it is finished or dropped, so it can be consumed by
    /// value without leaving a half-alive one behind.
    recording: Option<OpusRecording<S>>,
    /// From the microphone's rate to [`RECORDING_RATE`]; `None` when they are
    /// the same, and after the stream's tail is written.
    converter: Option<Box<RateConverter>>,
    write_failed: bool,
}

impl<S: Storage> CaptureFile<S> {
    /// Start the recording about to start, in the file just created for it
    /// at `path`.
    ///
    /// Mono at [`RECORDING_RATE`], from samples at `device_rate`. Mono
    /// because a dictation microphone is one voice and the transcriber
    /// downmixes anyway.
    fn open(path: PathBuf, file: S, device_rate: u32) -> Result<Self> {
        let converter = if device_rate == RECORDING_RATE {
            Ok(None)
        } else {
            RateConverter::new(device_rate, RECORDING_RATE)
                .map(|converter| Some(Box::new(converter)))
        };
        let opened = converter.and_then(|converter| {
            OpusRecording::new(file)
                .map(|recording| (converter, recording))
                .map_err(|error| {
                    RecorderError::failed(format!("start {}: {error}", path.display()))
                })
        });
        match opened {
            Ok((converter, recording)) => Ok(Self {
                path,
                recording: Some(recording),
                converter,
                write_failed: false,
            }),
            // A file nothing can be recorded into is debris, not a recording
            // waiting to happen.
            Err(error) => {
                if let Err(cleanup) = remove_recording(&path) {
                    warn!("{cleanup}");
                }
                Err(error)
            }
        }
    }

    /// Append one callback's worth of mono PCM16 at the microphone's rate.
    fn write(&mut self, samples: &[i16]) -> Result<()> {
        let result = match self.converter.as_mut() {
            Some(converter) => converter
                .push(samples)
                .and_then(|converted| self.write_samples(&converted)),
            None => self.write_samples(samples),
        };
        if result.is_err() {
            self.write_failed = true;
        }
        result
    }

    /// Write what the converter still holds: the end of the stream.
    fn write_tail(&mut self) -> Result<()> {
        let Some(converter) = self.converter.take() else {
            return Ok(());
        };
        let result = converter
            .finish()
            .and_then(|tail| self.write_samples(&tail));
        if result.is_err() {
            self.write_failed = true;
        }
        result
    }

    fn write_samples(&mut self, samples: &[i16]) -> Result<()> {
        let Some(recording) = self.recording.as_mut() else {
            return Err(RecorderError::failed("the recording is already finalized"));
        };
        recording.write(samples).map_err(RecorderError::failed)
    }

    /// Pad a sub-second recording with silence to 1.25 seconds.
    ///
    /// A product behavior, not a format requirement: Whisper hallucinates
    /// sentences into near-silent clips shorter than about a second.
    ///
    /// A recording that captured nothing is left empty. There is no speech to
    /// protect, and padding it would turn "we heard nothing" into 1.25 s of
    /// silence that looks like a real recording.
    fn pad_if_short(&mut self) -> Result<()> {
        // Straight from the writer's own count, so the padding decision can
        // never disagree with the file.
        let captured = self
            .recording
            .as_ref()
            .map_or(0, |recording| recording.samples());
        let short = u64::from(RECORDING_RATE);
        if captured == 0 || captured >= short {
            return Ok(());
        }
        let target = short + short / 4;
        let padding = vec![0i16; (target - captured) as usize];
        self.write_samples(&padding)
    }

    /// Finish the file in place and report how long it plays.
    ///
    /// A capture whose writes failed keeps what reached the file: its whole
    /// seconds are finished as `staging::recover` would on the next open
    /// (`webm::finish_cut_off`). Nothing here deletes the file; one that
    /// cannot be finished now, as on a disk still full, stays for the next
    /// open.
    fn finish(mut self) -> Result<FinishedRecording> {
        let finished = if self.write_failed {
            Err(RecorderError::failed(
                "the recording could not be written to the end",
            ))
        } else {
            self.finish_recording()
        };
        let duration_ms = match finished {
            Ok(samples) => ms(samples * TO_48K),
            Err(error) => {
                drop(self.recording.take());
                warn!(
                    "Recording {} did not finish cleanly: {error}",
                    self.path.display()
                );
                match finish_cut_off(&self.path) {
                    Ok(CutOff::Finished { played } | CutOff::Recovered { played }) => ms(played),
                    Ok(CutOff::Empty) => {
                        return Err(RecorderError::failed(format!(
                            "{error}; nothing of it reached the disk"
                        )))
                    }
                    Err(finishing) => {
                        return Err(RecorderError::failed(format!(
                            "{error}; what was written could not be finished: {finishing}"
                        )))
                    }
                }
            }
        };
        Ok(FinishedRecording {
            path: std::mem::take(&mut self.path),
            duration_ms,
        })
    }

    /// The tail, the padding, and the file's end, answering how many samples
    /// play.
    fn finish_recording(&mut self) -> Result<u64> {
        self.write_tail()?;
        self.pad_if_short()?;
        let Some(recording) = self.recording.take() else {
            return Err(RecorderError::failed("the recording is already finalized"));
        };
        recording.finish().map_err(RecorderError::failed)
    }

    /// Delete a file whose stream never started, without finishing it.
    fn discard(mut self) -> Result<()> {
        drop(self.recording.take());
        remove_recording(&self.path)
    }
}

/// Samples at 48 kHz in milliseconds, to the nearest.
fn ms(samples_48k: u64) -> u32 {
    ((samples_48k + 24) / 48) as u32
}

/// Remove a recording's file, which only a capture that never started does.
/// A file already gone is not a failure.
fn remove_recording(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RecorderError::failed(format!(
            "remove the recording {}: {error}",
            path.display()
        ))),
    }
}

/// A capture's file, finished: where it is and how long it plays.
///
/// The capture behind it is closed: its microphone is released, its worker has
/// exited, and its file states its length.
#[derive(Debug)]
pub(crate) struct FinishedRecording {
    pub path: PathBuf,
    pub duration_ms: u32,
}

/// What `start` answers: the id to stop the recording by, and the
/// microphone it opened.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartedRecording {
    pub id: String,
    /// The name of the microphone that is recording.
    pub device: String,
}

/// What `stop` answers once the recording is finished and at its path, and
/// the microphone released: where it is and how long it plays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StoppedRecording {
    /// Its folder-relative path: the path the page named plus `.webm`.
    pub path: String,
    pub duration_ms: u32,
}

/// What the recorder calls when capture ends on its own, with the recording's
/// id. The plugin supplies it: it marks the recording ended, refreshes the
/// shell's indicator, and tells the owner. Never called on an audio thread.
pub type OnEnded = Arc<dyn Fn(&str, EndedReason) + Send + Sync>;

/// The one recording the recorder holds: its identity, its owner, and the
/// worker carrying it.
///
/// "Held" rather than "in flight", because capture may already be over. The
/// recording keeps this slot either way until its owner resolves it.
struct HeldRecording {
    /// The id the host minted at `start`.
    id: String,
    /// Label of the window that called `start`. Stop is restricted to it.
    owner_label: String,
    /// The recording's file while it records, absolute, in the folder's
    /// `.epicenter/recordings`, which `recover` leaves alone.
    path: PathBuf,
    /// The folder it is placed in once it stops.
    root: PathBuf,
    /// Its folder-relative path there without an extension, as the page
    /// named it.
    stem: String,
    /// `None` while capture is running. `Some` once capture ended on its own,
    /// which is a fact about this recording and not a separate state machine:
    /// everything else about it is unchanged.
    ended_reason: Option<EndedReason>,
    /// The owner page's channel, for the one signal sent from outside the
    /// worker: that capture ended.
    signals: Channel<RecordingSignal>,
    cmd_tx: mpsc::Sender<RecorderCmd>,
    worker: JoinHandle<()>,
}

/// CPAL-backed audio recorder.
///
/// `Option<HeldRecording>` is the whole state machine: `Some` means a recording
/// occupies the one slot, `None` means idle. There is no separate "session
/// opened but not recording" phase, which is why no atomic flag is needed to
/// tell the two apart, and no separate "interrupted" collection, because an
/// interrupted recording is the same `Some` with a reason attached.
#[derive(Default)]
pub struct Recorder {
    active: Option<HeldRecording>,
    /// Exit seals capture before finalization, including requests still
    /// waiting for microphone permission or a meter's worker.
    stopped: bool,
    /// How many pages each window has shown, so a `start` a departed page
    /// sent is refused rather than recording for a page that cannot stop it.
    pages: HashMap<String, u64>,
    /// Open meters by id, each with the label of the window that opened it.
    /// Any number may be open, beside a recording or not: a meter holds no
    /// slot and writes nothing.
    meters: HashMap<String, (String, Meter)>,
}

/// Ids are unique for the life of the process, so a stale `stop` never names
/// a later recording.
static NEXT_RECORDING: AtomicU64 = AtomicU64::new(1);

/// A fresh id for a recording or a meter.
pub(crate) fn next_id() -> String {
    NEXT_RECORDING.fetch_add(1, Ordering::Relaxed).to_string()
}

impl Recorder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Which page `owner` is showing, counted from zero. A command reads it on
    /// arrival and compares under the recorder lock before it acts.
    pub fn page(&self, owner: &str) -> u64 {
        self.pages.get(owner).copied().unwrap_or(0)
    }

    /// The page `owner` showed is gone, by a reload or because the window
    /// closed: finalize what it was recording, which nobody can stop now, and
    /// count the next page.
    /// Also answers whether it closed any meter, which changes whether a
    /// microphone is open.
    pub fn page_ended(&mut self, owner: &str) -> (Option<StoppedRecording>, bool) {
        *self.pages.entry(owner.to_string()).or_default() += 1;
        let meters = self.meters.len();
        self.meters
            .retain(|_, (meter_owner, _)| meter_owner != owner);
        let meters_closed = self.meters.len() != meters;
        (self.finish_owned_by(owner), meters_closed)
    }

    /// Keep the meter `id` that `owner` opened while it showed page `page`. A
    /// meter whose page has gone since, or whose stream already stopped, is
    /// closed at once and refused, since nothing is left to close it.
    pub(crate) fn add_meter(
        &mut self,
        id: &str,
        page: u64,
        owner: &str,
        meter: Meter,
    ) -> Result<()> {
        self.require_running()?;
        if self.page(owner) != page {
            return Err(RecorderError::not_recording(
                "the page that asked for a meter has gone",
            ));
        }
        if meter.is_gone() {
            return Err(RecorderError::failed(
                "the meter's microphone stopped as it opened",
            ));
        }
        self.meters
            .insert(id.to_string(), (owner.to_string(), meter));
        Ok(())
    }

    /// Drop the meter `id`, whose worker stopped on its own, answering whether
    /// it was held.
    pub(crate) fn remove_meter(&mut self, id: &str) -> bool {
        self.meters.remove(id).is_some()
    }

    /// Close the meter `id`, releasing its microphone. Restricted to the window
    /// that opened it.
    pub fn close_meter(&mut self, id: &str, caller_label: &str) -> Result<()> {
        match self.meters.get(id) {
            Some((owner, _)) if owner == caller_label => {
                self.meters.remove(id);
                Ok(())
            }
            _ => Err(RecorderError::not_recording(format!(
                "this window has no open meter '{id}'"
            ))),
        }
    }

    /// How many meters are open, for tests.
    #[cfg(test)]
    pub(crate) fn open_meters(&self) -> usize {
        self.meters.len()
    }

    /// Create the recording's file, open the input stream, and begin
    /// capturing, in one step.
    ///
    /// Returns [`RecorderError::Busy`] when the slot is occupied, so a competing
    /// start is refused instead of displacing a recording some other window is
    /// relying on. A recording whose capture already ended still occupies it:
    /// its audio is the owner's until it stops it or its page ends, and
    /// quietly finalizing it to make room would take that from the owner.
    ///
    /// The device is resolved here rather than by the caller. `requested_device`
    /// is the id of the microphone the person chose; when none with that id
    /// is connected this refuses with [`RecorderError::InputUnavailable`]
    /// rather than opening another, because recording from a microphone the
    /// person did not choose is not what they asked for. `None` is the system
    /// default.
    ///
    /// `pending` is the checked absolute path the recording is written to
    /// while it records, in the folder's `.epicenter/recordings`; `root` is
    /// the folder it is placed in when it stops, and `stem` its
    /// folder-relative path there without an extension, as the page named it. The file is created
    /// only after the device and its configuration resolve, and never over
    /// anything already there.
    ///
    /// The cpal stream is built inside the worker (macOS requires the stream and
    /// the run loop driving it to share a thread) and its outcome is reported
    /// back over `ready_rx`, so a stream that fails to open surfaces as the real
    /// classified error rather than as a dropped channel.
    pub fn start(
        &mut self,
        requested_device: Option<&str>,
        pending: PathBuf,
        root: PathBuf,
        stem: String,
        owner_label: String,
        signals: Channel<RecordingSignal>,
        on_ended: OnEnded,
    ) -> Result<StartedRecording> {
        self.require_free_slot()?;

        let host = cpal::default_host();
        let (device, device_name) = resolve_device(&host, requested_device)?;
        let config = input_config(&device)?;
        let sample_format = config.sample_format();
        let device_rate = config.sample_rate();
        let device_channels = config.channels();

        let stream_config = cpal::StreamConfig {
            channels: device_channels,
            sample_rate: device_rate,
            buffer_size: cpal::BufferSize::Default,
        };

        // The file is created before the microphone opens, so a recording that
        // cannot be written fails now rather than after an hour of captured
        // speech. `create_new` refuses whatever is at the path, a link
        // included, so nothing already there is written through.
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::AlreadyExists => RecorderError::refused(format!(
                    "a recording of {stem} is already waiting at {}",
                    pending.display()
                )),
                _ => RecorderError::failed(format!("create {}: {error}", pending.display())),
            })?;
        let capture = CaptureFile::open(pending.clone(), file, device_rate)?;

        let id = next_id();
        let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<i16>>(CAPTURE_QUEUE_CHUNKS);
        let (cmd_tx, cmd_rx) = mpsc::channel::<RecorderCmd>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
        let dropped_chunks = Arc::new(AtomicU32::new(0));
        let sink = ChunkSink {
            sample_tx,
            dropped_chunks: Arc::clone(&dropped_chunks),
        };
        let on_error = capture_error_handler(Arc::clone(&on_ended), id.clone());
        let worker_signals = signals.clone();
        let worker_id = id.clone();

        let worker = thread::spawn(move || {
            let stream = match build_input_stream(
                &device,
                stream_config,
                sample_format,
                device_channels,
                sink,
                on_error,
            )
            .and_then(|stream| {
                stream
                    .play()
                    .map_err(|e| RecorderError::classify_cpal("Failed to start stream", e))?;
                Ok(stream)
            }) {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    stream
                }
                Err(error) => {
                    // Nothing was ever captured, so the file this created is
                    // debris rather than a recording anyone could claim.
                    if let Err(cleanup) = capture.discard() {
                        warn!("{cleanup}");
                    }
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };

            info!("Audio stream started successfully");
            // Capture begins the moment the stream plays. Samples produced
            // before the loop is entered wait in `sample_rx`, so nothing
            // between `play()` and the first iteration is lost.
            // `run_capture` owns the stream and closes it the instant capture is
            // over, however it ended. A recording waiting to be claimed must not
            // keep the device open, the person should see the OS recording
            // indicator go out when their microphone stops working, and the final
            // drain is only complete once the sender is gone.
            let outcome = run_capture(
                sample_rx,
                &cmd_rx,
                capture,
                stream,
                CaptureContext {
                    id: &worker_id,
                    dropped_chunks: &dropped_chunks,
                    signals: worker_signals,
                    on_ended,
                },
            );
            if let CaptureOutcome::Unclaimed(capture) = outcome {
                await_resolution(*capture, &cmd_rx);
            }
        });

        match ready_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = worker.join();
                return Err(error);
            }
            Err(error) => {
                let _ = worker.join();
                return Err(RecorderError::failed(format!(
                    "recorder worker exited before reporting stream readiness: {error}"
                )));
            }
        }

        info!(
            "Recording started: id={id}, owner={owner_label}, path={stem}, device={device_name}, {device_rate} Hz, {device_channels} channels",
        );
        self.active = Some(HeldRecording {
            id: id.clone(),
            owner_label,
            path: pending,
            root,
            stem,
            ended_reason: None,
            signals,
            cmd_tx,
            worker,
        });
        Ok(StartedRecording {
            id,
            device: device_name,
        })
    }

    /// Mark the recording named by `id` as ended because its capture stopped
    /// on its own, returning its owner's channel so the host can tell it.
    ///
    /// This ends the *capture*, not the recording. The worker releases the
    /// microphone and keeps everything it captured, and the slot stays
    /// occupied. The owner finalizes it with `stop`, or its page's end does.
    ///
    /// Matched on the id, not just the owner: a stream error can arrive after
    /// the owner already started a second recording, and killing that one
    /// because its predecessor's hardware failed would be its own bug. A
    /// non-matching or already-ended id makes this a no-op, which is what makes
    /// it idempotent when cpal reports the same failure more than once.
    pub fn end_capture(
        &mut self,
        id: &str,
        reason: EndedReason,
    ) -> Option<Channel<RecordingSignal>> {
        let active = self.active.as_mut()?;
        if active.id != id || active.ended_reason.is_some() {
            return None;
        }
        active.ended_reason = Some(reason);
        // Sent, never joined. This runs under the recorder lock, and the worker
        // it is signalling may be mid-handoff with a `stop` that is waiting on
        // that same lock; joining here would deadlock the pair. The channel is
        // unbounded, so the send itself cannot block. A send failure means the
        // worker is already gone, which is the same outcome by another route.
        let _ = active.cmd_tx.send(RecorderCmd::EndCapture);
        Some(active.signals.clone())
    }

    /// Stop the recording named by `id`, finish its file, and place it at its
    /// path. Restricted to the window that started it.
    ///
    /// Works the same whether capture is still running or already ended. That is
    /// the point of holding an ended recording: `stop` is the one finalizing
    /// path, so the audio captured before a microphone died is reached by the
    /// same call as the audio captured before the person let go of the button.
    pub fn stop(&mut self, id: &str, caller_label: &str) -> Result<StoppedRecording> {
        self.require_owned(id, caller_label)?;
        let active = self.active.take().expect("ownership was just verified");
        finish(active)
    }

    /// Finalize the held recording if `owner_label` owns it. The host's own
    /// path, used when the owner's page is gone: nobody can stop the recording
    /// now, so holding the single recorder slot for it would wedge every other
    /// window, and deleting it would lose what the person said.
    pub fn finish_owned_by(&mut self, owner_label: &str) -> Option<StoppedRecording> {
        let active = self
            .active
            .take_if(|active| active.owner_label == owner_label)?;
        let id = active.id.clone();
        match finish(active) {
            Ok(stopped) => {
                info!(
                    "Recording {id} finalized at {} because its page is gone",
                    stopped.path
                );
                Some(stopped)
            }
            Err(error) => {
                warn!("Recording {id} could not be finalized after its page left: {error}");
                None
            }
        }
    }

    /// Refuse further capture and finalize held audio for the app's exit, as
    /// a stop does. Calling this again is harmless; cancelling Quit never
    /// calls it.
    pub fn shutdown(&mut self) {
        self.stopped = true;
        self.meters.clear();
        if let Some(active) = self.active.take() {
            if let Err(error) = finish(active) {
                warn!("The recording held at exit could not be finalized: {error}");
            }
        }
    }

    pub(crate) fn require_running(&self) -> Result<()> {
        if self.stopped {
            return Err(RecorderError::not_recording("the recorder has shut down"));
        }
        Ok(())
    }

    /// Whether a microphone is open right now, by the recording or a meter,
    /// for the host's tray indicator.
    ///
    /// Deliberately not "is the slot occupied". A recording whose capture died
    /// still holds the slot, but nothing is being captured, and a tray that kept
    /// claiming otherwise would be lying about the microphone.
    pub fn is_capturing(&self) -> bool {
        !self.meters.is_empty() || self.is_recording()
    }

    /// A recording whose capture ended still holds the slot until its owner
    /// stops it, but departure would no longer cut it off. Meters do not record.
    pub fn is_recording(&self) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.ended_reason.is_none())
    }

    /// The file `recover` must leave alone: the held recording's, which its
    /// worker still writes.
    pub fn held_path(&self) -> Option<&Path> {
        self.active.as_ref().map(|active| active.path.as_path())
    }

    /// The one admission rule, in one place: the slot must be empty.
    ///
    /// A recording whose capture already ended still occupies it. Reporting that
    /// distinctly matters because the two look identical from outside and have
    /// different remedies: waiting out a live recording, versus stopping one
    /// that is over.
    ///
    /// Sits beside [`Recorder::require_owned`] rather than inline in `start`,
    /// because these are the recorder's two access rules and reading them
    /// together is how the slot's whole policy stays legible.
    fn require_free_slot(&self) -> Result<()> {
        self.require_running()?;
        let Some(active) = &self.active else {
            return Ok(());
        };
        let state = match active.ended_reason {
            None => "is already in flight",
            Some(_) => "has ended and is waiting to be stopped",
        };
        Err(RecorderError::busy(format!(
            "a recording ({}) started by window '{}' {state}",
            active.id, active.owner_label
        )))
    }

    /// The one ownership rule, in one place: the named recording must be the
    /// one held and must belong to the calling window.
    ///
    /// Both failures collapse to `NotRecording`. The caller cannot act
    /// differently on "no such recording" versus "not yours" (both mean "this
    /// window has nothing to stop"), and the distinguishing detail still
    /// travels in `message` for diagnostics.
    fn require_owned(&self, id: &str, caller_label: &str) -> Result<()> {
        let Some(active) = &self.active else {
            return Err(RecorderError::not_recording(format!(
                "no recording is held; '{id}' has already been stopped"
            )));
        };
        if active.id != id {
            return Err(RecorderError::not_recording(format!(
                "the in-flight recording is not '{id}'"
            )));
        }
        if active.owner_label != caller_label {
            return Err(RecorderError::not_recording(format!(
                "recording '{id}' is owned by window '{}', not '{caller_label}'",
                active.owner_label
            )));
        }
        Ok(())
    }
}

/// End a recording and keep it: tell the worker to finish the file, join it
/// so the cpal stream is released, and place the file at its path. A file
/// that could not be finished or placed stays in `.epicenter/recordings`,
/// where the next `recover` finishes and places it.
///
/// The slot is unavailable for the whole round trip, because the caller's
/// `&mut Recorder` comes from the one recorder mutex and nothing else can
/// acquire it until this returns. That is load-bearing: the worker is still
/// holding an open cpal stream until it answers, and a `start` that slipped in
/// beforehand would open a second microphone against a recorder that is
/// supposed to have exactly one. The whole of it takes the same few
/// milliseconds for a recording of any length.
fn finish(active: HeldRecording) -> Result<StoppedRecording> {
    let (reply_tx, reply_rx) = mpsc::channel();
    let finished = match active.cmd_tx.send(RecorderCmd::Stop(reply_tx)) {
        Ok(()) => reply_rx
            .recv()
            .map_err(|e| {
                RecorderError::failed(format!(
                    "Worker dropped the stop reply for {}: {e}",
                    active.id
                ))
            })
            .and_then(|result| result),
        Err(e) => Err(RecorderError::failed(format!(
            "Failed to send stop command: {e}"
        ))),
    };
    // Joined, not detached: the worker closes the capture stream before it
    // answers, and joining is what makes "the microphone is released" true
    // by the time the slot is observably free.
    let _ = active.worker.join();
    let kept = |error: String| {
        RecorderError::failed(format!(
            "{error}; the recording is kept in {} until the folder is opened again",
            active.path.display()
        ))
    };
    let finished = finished.map_err(|error| kept(error.to_string()))?;
    let path = crate::staging::place_recording(&active.root, &finished.path, &active.stem)
        .map_err(|error| match error {
            crate::staging::PlaceError::Taken(path) => RecorderError::refused(format!(
                "a file is already at {path}, so the recording was not placed there"
            )),
            crate::staging::PlaceError::Failed(error) => kept(error),
        })?;
    Ok(StoppedRecording {
        path,
        duration_ms: finished.duration_ms,
    })
}

/// A recorder going away keeps what it holds: the file is finalized, never
/// deleted.
impl Drop for Recorder {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Who a capture belongs to, and how to reach them.
///
/// One value rather than four parameters, because none of it is about audio:
/// it is the recording's identity and the two ways the worker speaks about it,
/// a meter to the owner's page and a failure report to the host.
struct CaptureContext<'a> {
    id: &'a str,
    dropped_chunks: &'a AtomicU32,
    signals: Channel<RecordingSignal>,
    on_ended: OnEnded,
}

/// What the capture phase left behind.
enum CaptureOutcome {
    /// The recording is resolved: a `Stop` finalized the file. Nothing is
    /// left to wait for.
    Resolved,
    /// Capture ended with the recording still unclaimed. The file is as
    /// capture left it and its owner may still stop it.
    Unclaimed(Box<CaptureFile>),
}

/// Capture phase. Encodes mono PCM16 into the recording's file as it arrives,
/// sending a throttled RMS level to the owner's page so its meter can reflect
/// live mic activity.
///
/// The capture file is passed by value because whichever way this ends, it
/// ends here: a `Stop` finalizes it, and anything else hands it back to be
/// waited on.
///
/// The cpal stream is passed by value for the same reason, and closed here
/// rather than by the caller. Closing it is what makes the final drain complete
/// rather than best-effort, so the two cannot be separated: see
/// [`close_capture_and_drain`].
fn run_capture<S>(
    sample_rx: mpsc::Receiver<Vec<i16>>,
    cmd_rx: &mpsc::Receiver<RecorderCmd>,
    mut capture: CaptureFile,
    stream: S,
    context: CaptureContext<'_>,
) -> CaptureOutcome {
    use std::sync::mpsc::RecvTimeoutError;

    let CaptureContext {
        id,
        dropped_chunks,
        signals,
        on_ended,
    } = context;

    let mut level = Level::new();
    let mut last_drop_report = Instant::now();

    loop {
        // Command channel has priority. Stop should respond fast even
        // when audio frames are arriving back-to-back.
        match cmd_rx.try_recv() {
            Ok(RecorderCmd::Stop(reply)) => {
                close_capture_and_drain(stream, &mut capture, &sample_rx);
                report_dropped_chunks(dropped_chunks, id);
                let _ = reply.send(capture.finish());
                return CaptureOutcome::Resolved;
            }
            // Capture is over but the recording is not: hand the file up so it
            // can wait for the owner to stop it.
            Ok(RecorderCmd::EndCapture) => {
                close_capture_and_drain(stream, &mut capture, &sample_rx);
                report_dropped_chunks(dropped_chunks, id);
                return CaptureOutcome::Unclaimed(Box::new(capture));
            }
            // The command sender is gone without a stop, so nobody is left to
            // claim this recording. It is kept, finalized.
            Err(mpsc::TryRecvError::Disconnected) => {
                close_capture_and_drain(stream, &mut capture, &sample_rx);
                let _ = capture.finish();
                return CaptureOutcome::Resolved;
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }

        // Dropped chunks are worth saying out loud but not worth saying fifty
        // times a second, so they are reported on an interval, and once more
        // before this returns so a drop just before a stop is never silent.
        if last_drop_report.elapsed() >= DROP_REPORT_INTERVAL {
            report_dropped_chunks(dropped_chunks, id);
            last_drop_report = Instant::now();
        }

        match sample_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(samples) => {
                level.add(&samples);

                if let Err(error) = capture.write(&samples) {
                    // A write that fails is terminal: the disk is full, or the
                    // volume vanished. Neither gets better by trying again, so
                    // the capture ends here and the recording keeps every whole
                    // second that reached the file.
                    error!("Recording {id} could not write its capture: {error}");
                    // Closed without draining: the writes that would consume the
                    // queue are the writes that are failing.
                    drop(stream);
                    let on_ended = Arc::clone(&on_ended);
                    let id = id.to_string();
                    // On its own thread for the same reason the cpal error
                    // callback uses one: this locks the recorder, and a `stop`
                    // may be holding that lock while waiting on this very
                    // worker.
                    thread::spawn(move || on_ended(&id, EndedReason::StorageFailed));
                    return CaptureOutcome::Unclaimed(Box::new(capture));
                }

                if let Some(level) = level.take(Instant::now()) {
                    // Over the owner's own channel, never a broadcast: a level
                    // is about one page's recording, and every other window is
                    // entitled not to hear it. Not an error if the page is
                    // hidden or gone, and never fatal.
                    let _ = signals.send(RecordingSignal::Level { level });
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            // The sample sender lives inside the cpal stream, which this
            // worker's caller owns and drops only after this returns, so this is
            // not reachable today. Park rather than finalize if it ever becomes
            // reachable: keeping the recording claimable is the safe direction.
            Err(RecvTimeoutError::Disconnected) => {
                drop(stream);
                return CaptureOutcome::Unclaimed(Box::new(capture));
            }
        }
    }
}

/// How long the final drain will wait for a capture stream to finish closing.
///
/// Only ever spent when cpal's teardown outlives the handle we dropped (see
/// [`close_capture_and_drain`]), which is a race against a device disconnect
/// rather than the ordinary path. Long enough for that teardown, short enough
/// that a stop cannot visibly hang on it.
const CAPTURE_CLOSE_TIMEOUT: Duration = Duration::from_millis(50);

/// Close the microphone, then write everything it already handed over.
///
/// The order is the whole point. The command channel is checked before the
/// sample channel, so a stop arrives with chunks still queued behind it: audio
/// the microphone captured before the person asked to stop, which finalizing
/// without would silently truncate the tail of every recording that stopped
/// during a backlog. But draining a channel whose sender is still live only
/// proves nothing had arrived *yet*; a callback firing between the last poll and
/// the sender being dropped would enqueue a chunk that then dies with the
/// receiver, and because `try_send` accepted it the drop counter would never say
/// so.
///
/// So this does not poll for emptiness, it waits for the channel to prove itself
/// closed. `Disconnected` is only reported once every sender is gone, and the
/// sender lives inside the capture callback, so that answer means the queue is
/// drained *and* nothing more can arrive. Nothing else establishes it: dropping
/// the stream is what starts the teardown, but it does not always finish it
/// here. cpal's macOS backend keeps the stream behind an `Arc` its disconnect
/// monitor can transiently hold, so the `AudioUnit` teardown that frees the
/// callback may complete on that thread a moment later.
///
/// The wait is bounded because that monitor is the one thing that could make it
/// long, and a stop that hangs on a wedged audio backend is worse than a stop
/// that gives up the last few milliseconds. Timing out is logged rather than
/// silent, because it is the only path by which this returns without the
/// guarantee.
///
/// Generic over the stream because only its `Drop` matters here: nothing in this
/// function calls a cpal method, and a test can supply any value whose drop
/// closes the sender.
///
/// A write failure is not fatal to the stop: it means the disk is gone, and
/// keeping the prefix that reached it beats failing the whole recording.
fn close_capture_and_drain<S>(
    stream: S,
    capture: &mut CaptureFile,
    sample_rx: &mpsc::Receiver<Vec<i16>>,
) {
    drop(stream);
    let deadline = Instant::now() + CAPTURE_CLOSE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match sample_rx.recv_timeout(remaining) {
            Ok(samples) => {
                if let Err(error) = capture.write(&samples) {
                    warn!("Could not write the last queued audio, finalizing without it: {error}");
                    return;
                }
            }
            // Every sender is gone: the queue is empty and stays empty.
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                warn!(
                    "Capture stream did not finish closing within {CAPTURE_CLOSE_TIMEOUT:?}; finalizing what reached the writer"
                );
                return;
            }
        }
    }
}

/// Report and reset the chunks the callback had to drop, if any.
///
/// Swapped rather than read, so no count is lost between reports.
fn report_dropped_chunks(dropped_chunks: &AtomicU32, id: &str) {
    let dropped = dropped_chunks.swap(0, Ordering::Relaxed);
    if dropped > 0 {
        warn!(
            "Recording {id} dropped {dropped} audio chunks: the writer is not keeping up with the microphone"
        );
    }
}

/// Wait for the owner to resolve a recording whose capture is over.
///
/// The file stays exactly as capture left it, and this thread is the only
/// writer that can reach it. That is what makes "an ended recording is still
/// the owner's to claim" true without a catch-up queue or a restore call: the
/// same `Stop` a live recording answers is answered here, from the same file.
fn await_resolution(capture: CaptureFile, cmd_rx: &mpsc::Receiver<RecorderCmd>) {
    loop {
        match cmd_rx.recv() {
            // The recorder itself is gone, with nobody left to tell. The
            // recording is kept, finalized.
            Err(_) => {
                let _ = capture.finish();
                return;
            }
            Ok(RecorderCmd::Stop(reply)) => {
                let _ = reply.send(capture.finish());
                return;
            }
            // `end_capture` refuses to signal an already-ended recording, so
            // this cannot arrive twice; ignoring it keeps that a fact about the
            // recorder rather than something this loop has to enforce.
            Ok(RecorderCmd::EndCapture) => {}
        }
    }
}

/// Resolve the microphone to open: the one whose id is `requested`, or the
/// system default when none is named. Answers it with its name.
///
/// The id is the one [`list_inputs`] answers, cpal's `DeviceId` as text
/// (`coreaudio:<device UID>` on macOS), which stays the same across launches,
/// reconnections, and renames. A named microphone that is not connected is
/// refused, never replaced by the default: recording from another would put a
/// different voice, or none, in the file the person thinks holds theirs.
pub(crate) fn resolve_device(
    host: &cpal::Host,
    requested: Option<&str>,
) -> Result<(Device, String)> {
    let Some(requested) = requested else {
        let device = host.default_input_device().ok_or_else(|| {
            RecorderError::no_input_device("No microphone is available to record from")
        })?;
        let name = device_name(&device)?;
        return Ok((device, name));
    };
    let device = requested
        .parse::<cpal::DeviceId>()
        .ok()
        .and_then(|id| host.device_by_id(&id))
        .ok_or_else(|| RecorderError::InputUnavailable {
            message: format!("No microphone with the id “{requested}” is connected"),
        })?;
    let name = device_name(&device)?;
    Ok((device, name))
}

/// A microphone the page can choose: the id to ask for it by, the name it gives
/// itself, and whether the system uses it by default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// The input devices connected now. Listing opens no stream, so it needs no
/// microphone permission. A device that cannot say its id or name, which is
/// one being disconnected as it is listed, is left out.
pub(crate) fn list_inputs(host: &cpal::Host) -> Result<Vec<Input>> {
    let default = host
        .default_input_device()
        .and_then(|device| device.id().ok());
    let devices = host
        .input_devices()
        .map_err(|e| RecorderError::classify_cpal("Failed to list input devices", e))?;
    Ok(devices
        .filter_map(|device| {
            let id = device.id().ok()?;
            let name = device_name(&device).ok()?;
            Some(Input {
                is_default: default.as_ref() == Some(&id),
                id: id.to_string(),
                name,
            })
        })
        .collect())
}

/// The name a device calls itself, which the page shows. A device that cannot
/// describe itself is refused rather than given a placeholder.
fn device_name(device: &Device) -> Result<String> {
    device
        .description()
        .map(|description| description.name().to_string())
        .map_err(|e| RecorderError::classify_cpal("Failed to read the input device name", e))
}

/// The configuration to open `device` with: the one it is running at now.
///
/// Opening at any other rate makes cpal set the device's nominal rate, which on
/// macOS changes it for every process using the microphone and outlasts the
/// stream (`build_input_stream_raw` in cpal 0.18's CoreAudio host). The rate is
/// converted afterwards, by the writer, never by the device.
pub(crate) fn input_config(device: &Device) -> Result<cpal::SupportedStreamConfig> {
    // A device that cannot describe how it is running is unusable as an
    // input, which for the person is indistinguishable from "no mic," so a
    // generic failure collapses to NoInputDevice ("connect a microphone").
    // cpal 0.18 types a true denial as PermissionDenied and often routes a
    // vanished mic to a generic kind (macOS sends the OSStatus failure to
    // BackendError), so only a Failed is remapped; a PermissionDenied passes
    // through untouched.
    let config = device.default_input_config().map_err(|e| {
        match RecorderError::classify_cpal("Failed to read the input configuration", e) {
            RecorderError::Failed { message } => RecorderError::NoInputDevice { message },
            classified => classified,
        }
    })?;
    match config.sample_format() {
        // CoreAudio describes every input as F32 or I16
        // (`default_config` in cpal 0.18's macOS host).
        SampleFormat::F32 | SampleFormat::I16 => Ok(config),
        other => Err(RecorderError::failed(format!(
            "The microphone runs in {other:?}; recording supports F32 and I16"
        ))),
    }
}

/// Where a cpal callback puts a chunk: into the writer's queue, or on the floor.
///
/// One value rather than two parameters, because the counter is meaningless
/// apart from the channel whose refusals it counts.
pub(crate) struct ChunkSink {
    pub(crate) sample_tx: mpsc::SyncSender<Vec<i16>>,
    pub(crate) dropped_chunks: Arc<AtomicU32>,
}

impl ChunkSink {
    /// Hand a chunk to the writer, or drop it and count it.
    ///
    /// `try_send` rather than `send`, because the alternative is blocking the
    /// audio thread on a stalled disk, which does not save the recording and
    /// does glitch every other sound on the machine. A drop costs one callback
    /// of audio, roughly ten milliseconds, and the worker reports it.
    fn hand_off(&self, chunk: Vec<i16>) {
        if self.sample_tx.try_send(chunk).is_err() {
            self.dropped_chunks.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// What a live cpal stream error does to the recording it belongs to.
///
/// A stream error used to be logged and nothing else, which left the one
/// recorder slot occupied, the tray claiming a recording, and the owner window
/// waiting for audio that would never arrive. Now a terminal error ends the
/// capture, releases the microphone, and tells the owner why, while the
/// recording itself stays claimable.
///
/// Only a terminal error: [`classify`] returns `None` for the conditions cpal
/// documents as survivable, so a routine audio-route change (plugging in
/// headphones) no longer looks like a dead microphone.
///
/// [`classify`]: crate::ended::classify
fn capture_error_handler(on_ended: OnEnded, id: String) -> impl Fn(cpal::Error) + Send + 'static {
    move |error: cpal::Error| {
        let Some(reason) = crate::ended::classify(&error) else {
            debug!("Audio stream reported a survivable condition, continuing: {error}");
            return;
        };
        error!("Audio stream ended the capture: {error}");
        let on_ended = Arc::clone(&on_ended);
        let id = id.clone();
        // On its own thread because this locks the recorder, which may not
        // happen on an audio callback. It fires at most once per stream death
        // and never on the sample path.
        thread::spawn(move || on_ended(&id, reason));
    }
}

/// Build the cpal input stream. The callback's only job is to downmix to mono
/// PCM16 and hand the chunk off; the worker owns the file and everything else.
pub(crate) fn build_input_stream(
    device: &Device,
    config: cpal::StreamConfig,
    sample_format: SampleFormat,
    channels: u16,
    sink: ChunkSink,
    on_error: impl Fn(cpal::Error) + Send + 'static,
) -> Result<Stream> {
    let n_channels = channels as usize;

    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                config,
                move |data: &[f32], _: &_| sink.hand_off(downmix_f32(data, n_channels)),
                on_error,
                None,
            )
            .map_err(|e| RecorderError::classify_cpal("Failed to build F32 stream", e))?,
        SampleFormat::I16 => device
            .build_input_stream(
                config,
                move |data: &[i16], _: &_| sink.hand_off(downmix_i16(data, n_channels)),
                on_error,
                None,
            )
            .map_err(|e| RecorderError::classify_cpal("Failed to build I16 stream", e))?,
        _ => {
            return Err(RecorderError::failed(format!(
                "Unsupported sample format: {sample_format:?}"
            )))
        }
    };

    Ok(stream)
}

/// Average interleaved frames down to one channel.
///
/// Written per input format rather than through a shared f32 intermediate,
/// because i16 is already PCM16: routing it through f32 and back would add a
/// rounding step to a conversion that has none.
fn downmix_f32(interleaved: &[f32], channels: usize) -> Vec<i16> {
    let to_pcm16 = |sample: f32| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
    if channels <= 1 {
        return interleaved.iter().copied().map(to_pcm16).collect();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| to_pcm16(frame.iter().sum::<f32>() / channels as f32))
        .collect()
}

fn downmix_i16(interleaved: &[i16], channels: usize) -> Vec<i16> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        // Summed as i32 so a loud stereo frame cannot overflow before it is
        // averaged back into range.
        .map(|frame| (frame.iter().map(|&s| s as i32).sum::<i32>() / channels as i32) as i16)
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The rate these tests hand the writer, the recording's own, so what a
    /// test writes is exactly what the file holds. A capture from a device at
    /// another rate has its own test, and the conversion its own in `rate.rs`.
    const TEST_RATE: u32 = RECORDING_RATE;

    /// The least loudness a live input has. Digital silence, which a stream
    /// that delivers nothing real produces, is exactly zero; a microphone's own
    /// noise floor, or the tone a loopback device is fed, is above this.
    const MIN_LIVE_RMS: f64 = 1e-4;

    #[test]
    #[ignore = "opens the physical default microphone for a second; run only for explicit native acceptance"]
    fn physical_microphone_writes_its_recording_in_place_and_reopens() {
        let root = folder_root();
        for name in ["first.webm", "second.webm"] {
            let (device, name_of_device) = resolve_device(&cpal::default_host(), None).unwrap();
            let config = input_config(&device).unwrap();
            let rate = config.sample_rate();
            let path = root.path().join(name);
            let file = File::options()
                .write(true)
                .create_new(true)
                .open(&path)
                .unwrap();
            let mut capture = CaptureFile::open(path.clone(), file, rate).unwrap();
            let (tx, rx) = mpsc::sync_channel(CAPTURE_QUEUE_CHUNKS);
            let dropped = Arc::new(AtomicU32::new(0));
            let stream = build_input_stream(
                &device,
                cpal::StreamConfig {
                    channels: config.channels(),
                    sample_rate: rate,
                    buffer_size: cpal::BufferSize::Default,
                },
                config.sample_format(),
                config.channels(),
                ChunkSink {
                    sample_tx: tx,
                    dropped_chunks: dropped.clone(),
                },
                |error| eprintln!("NATIVE_CAPTURE_STREAM_ERROR {error}"),
            )
            .unwrap();
            stream.play().unwrap();
            let mut captured = 0usize;
            let mut sum_of_squares = 0f64;
            let until = Instant::now() + Duration::from_millis(1_500);
            while Instant::now() < until {
                if let Ok(samples) = rx.recv_timeout(Duration::from_millis(20)) {
                    captured += samples.len();
                    sum_of_squares += samples
                        .iter()
                        .map(|&sample| (sample as f64 / 32_768.0).powi(2))
                        .sum::<f64>();
                    capture.write(&samples).unwrap();
                }
            }
            close_capture_and_drain(stream, &mut capture, &rx);
            let finished = capture.finish().unwrap();
            let samples = samples_in(&finished.path);
            let rms = (sum_of_squares / captured.max(1) as f64).sqrt();
            eprintln!(
                "NATIVE_CAPTURE_RESULT device={name_of_device}, rate={rate}, captured={captured}, rms={rms:.5}, duration_ms={}, samples={samples}",
                finished.duration_ms
            );
            assert_eq!(dropped.load(Ordering::Relaxed), 0);
            // Longer than the 1 s below which a recording is padded, so the
            // duration is what the microphone delivered, not the padding.
            assert!(
                captured as f64 >= rate as f64 * 1.3,
                "the microphone delivered {captured} samples at {rate} Hz in 1.5 s"
            );
            assert!(finished.duration_ms >= 1_300, "{} ms", finished.duration_ms);
            assert!(rms > MIN_LIVE_RMS, "the input was silent: rms {rms}");
            // Opening the microphone left its rate alone, for every other app.
            let after = input_config(&device).unwrap().sample_rate();
            assert_eq!(
                after, rate,
                "the device's rate changed from {rate} to {after}"
            );
        }
    }

    /// A folder that disappears with the test.
    fn folder_root() -> TempDir {
        tempfile::tempdir().expect("a temporary folder")
    }

    /// One second of a 440 Hz tone as mono PCM16, so a recording has content a
    /// reader can be checked against rather than just a length.
    fn tone(rate: u32, seconds: u32) -> Vec<i16> {
        (0..(rate * seconds))
            .map(|index| {
                let t = index as f32 / rate as f32;
                ((2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.5 * i16::MAX as f32) as i16
            })
            .collect()
    }

    /// A capture holding `samples` in a new file `name`, ready to be finished.
    fn capture_holding(root: &TempDir, name: &str, samples: &[i16]) -> CaptureFile {
        let path = root.path().join(name);
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&path)
            .expect("create the recording");
        let mut capture = CaptureFile::open(path, file, TEST_RATE).expect("open the capture");
        capture.write(samples).expect("write the capture");
        capture
    }

    /// A channel to a page that hears nothing.
    fn no_page() -> Channel<RecordingSignal> {
        Channel::new(|_| Ok(()))
    }

    /// Stand up a `HeldRecording` without opening a microphone.
    ///
    /// The lifecycle rules are pure state, so they are tested against real
    /// `Recorder` state rather than through cpal: a test that needs an input
    /// device cannot run in CI, and the rules being checked have nothing to do
    /// with audio.
    ///
    /// The stand-in worker is the real [`await_resolution`], parked on a real
    /// capture in a temporary folder. That is exactly the state a worker is in
    /// once its capture has ended, so `stop` here finishes and places an
    /// actual recording rather than a mock of one, and a dropped recorder
    /// cannot hang its join: `await_resolution` returns on `Stop` and on a
    /// dropped channel.
    fn recording_owned_by(recorder: &mut Recorder, root: &TempDir, id: &str, owner_label: &str) {
        std::fs::create_dir_all(root.path().join("staging")).unwrap();
        hold_recording(
            recorder,
            &staged_in(root, id),
            root.path(),
            id,
            id,
            owner_label,
        );
    }

    /// Where `recording_owned_by` writes the recording `id` while it is held.
    fn staged_in(root: &TempDir, id: &str) -> PathBuf {
        root.path().join("staging").join(format!("{id}.webm"))
    }

    /// Hold a one-second recording written at `staged` for `owner_label`, to
    /// be placed at `stem` in `root` when it stops, as `start` would have,
    /// without a microphone. The plugin's own tests use it too.
    pub(crate) fn hold_recording(
        recorder: &mut Recorder,
        staged: &Path,
        root: &Path,
        stem: &str,
        id: &str,
        owner_label: &str,
    ) {
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(staged)
            .expect("create the recording");
        let mut capture =
            CaptureFile::open(staged.to_path_buf(), file, TEST_RATE).expect("open the capture");
        capture
            .write(&tone(TEST_RATE, 1))
            .expect("write the capture");
        let (cmd_tx, cmd_rx) = mpsc::channel::<RecorderCmd>();
        let worker = thread::spawn(move || await_resolution(capture, &cmd_rx));
        recorder.active = Some(HeldRecording {
            id: id.to_string(),
            owner_label: owner_label.to_string(),
            path: staged.to_path_buf(),
            root: root.to_path_buf(),
            stem: stem.to_string(),
            ended_reason: None,
            signals: no_page(),
            cmd_tx,
            worker,
        });
    }

    fn error_name(error: &RecorderError) -> &'static str {
        match error {
            RecorderError::PermissionDenied { .. } => "PermissionDenied",
            RecorderError::NoInputDevice { .. } => "NoInputDevice",
            RecorderError::InputUnavailable { .. } => "InputUnavailable",
            RecorderError::Busy { .. } => "Busy",
            RecorderError::NotRecording { .. } => "NotRecording",
            RecorderError::Refused { .. } => "Refused",
            RecorderError::Failed { .. } => "Failed",
        }
    }

    /// The samples the finished recording at `path` plays, read back through
    /// the decoder transcription reads it with.
    fn samples_in(path: &Path) -> usize {
        tauri_plugin_epicenter_transcription::audio::decode_to_pcm16k_mono(
            &std::fs::read(path).expect("a recording"),
        )
        .expect("a recording that decodes")
        .len()
    }

    #[test]
    fn a_fresh_recorder_is_idle_and_owns_nothing() {
        let recorder = Recorder::new();
        assert!(!recorder.is_capturing());
        assert!(recorder.held_path().is_none());
        recorder
            .require_free_slot()
            .expect("an idle recorder admits a start");
    }

    /// The point of writing as it records: every whole second a capture
    /// wrote is in the recording's file before anyone stops it, and a stop
    /// adds the last and states its length.
    #[test]
    fn a_recording_is_its_file_from_the_first_sample() {
        let root = folder_root();
        let capture = capture_holding(&root, "a.webm", &tone(TEST_RATE, 3));
        let path = root.path().join("a.webm");
        let before = std::fs::metadata(&path).unwrap().len();
        assert!(before > 4_000, "two whole seconds are already in the file");
        let finished = capture.finish().unwrap();
        assert_eq!(finished.path, path);
        assert_eq!(finished.duration_ms, 3_000);
        assert_eq!(samples_in(&path), 3 * TEST_RATE as usize);
    }

    /// A page that reloads or closes cannot stop its recording, so the host
    /// finishes and places it: the audio is kept and the slot is free. The
    /// page count moves on, which is what refuses a `start` the departed page
    /// sent late.
    #[test]
    fn a_departed_page_finalizes_its_recording_and_counts_the_next_page() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");
        let page = recorder.page("app-notes");

        assert!(recorder.page_ended("whispering").0.is_none());
        assert!(
            recorder.is_capturing(),
            "another window's page leaving changes nothing"
        );
        assert_eq!(recorder.page("app-notes"), page);

        let stopped = recorder
            .page_ended("app-notes")
            .0
            .expect("the departed page's recording is finalized");
        assert_eq!(
            stopped,
            StoppedRecording {
                path: "1.webm".to_string(),
                duration_ms: 1_000
            }
        );
        assert_eq!(samples_in(&root.path().join("1.webm")), TEST_RATE as usize);
        assert!(!staged_in(&root, "1").exists());
        assert!(recorder.held_path().is_none());
        assert_ne!(recorder.page("app-notes"), page);
        recorder
            .require_free_slot()
            .expect("the slot is free once the page is gone");
    }

    #[test]
    fn a_dropped_recorder_finalizes_what_it_holds() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");
        drop(recorder);
        assert_eq!(samples_in(&root.path().join("1.webm")), TEST_RATE as usize);
    }

    #[test]
    fn a_non_owner_cannot_stop_and_the_recording_survives() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");

        let stop = recorder
            .stop("1", "whispering")
            .expect_err("a non-owner must not stop another window's recording");
        assert_eq!(error_name(&stop), "NotRecording");

        // The refusal left the owner's recording completely untouched.
        assert!(recorder.is_capturing());
        assert!(staged_in(&root, "1").exists());
        assert!(!root.path().join("1.webm").exists());
    }

    #[test]
    fn the_owner_cannot_stop_an_id_that_is_not_the_live_recording() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");

        let error = recorder
            .stop("2", "app-notes")
            .expect_err("a stale id must not stop whatever happens to be live");
        assert_eq!(error_name(&error), "NotRecording");
        assert!(recorder.is_capturing());
    }

    /// Stop answers once the recording is finished and at its path.
    #[test]
    fn a_stopped_recording_is_at_its_path_when_stop_answers() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");

        let stopped = recorder.stop("1", "app-notes").unwrap();
        assert_eq!(
            stopped,
            StoppedRecording {
                path: "1.webm".to_string(),
                duration_ms: 1_000
            }
        );
        assert_eq!(samples_in(&root.path().join("1.webm")), TEST_RATE as usize);
        assert!(!staged_in(&root, "1").exists(), "moved, not copied");
        assert!(recorder.held_path().is_none());
        recorder
            .require_free_slot()
            .expect("the slot is free once it is placed");

        let again = recorder
            .stop("1", "app-notes")
            .expect_err("there is nothing left to stop");
        assert_eq!(error_name(&again), "NotRecording");
    }

    /// A file something made at the recording's path meanwhile is never
    /// replaced: the refusal says so, and the finished recording stays
    /// where it was recorded.
    #[test]
    fn a_stop_never_replaces_a_file_at_its_path() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");
        std::fs::write(root.path().join("1.webm"), b"theirs").unwrap();
        let refused = recorder.stop("1", "app-notes").unwrap_err();
        assert_eq!(error_name(&refused), "Refused");
        assert!(
            refused.to_string().contains("already at 1.webm"),
            "{refused}"
        );
        assert_eq!(
            std::fs::read(root.path().join("1.webm")).unwrap(),
            b"theirs"
        );
        assert_eq!(samples_in(&staged_in(&root, "1")), TEST_RATE as usize);
        recorder
            .require_free_slot()
            .expect("the slot is free either way");
    }

    /// A destroyed window can never claim its recording, so the host finalizes
    /// it, whether or not its capture already ended. This is the one route by
    /// which an ended recording releases the slot without its owner.
    #[test]
    fn a_departed_owner_also_finalizes_an_ended_recording() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");
        recorder.end_capture("1", EndedReason::StreamFailed);

        assert!(recorder.finish_owned_by("app-notes").is_some());
        assert_eq!(samples_in(&root.path().join("1.webm")), TEST_RATE as usize);
        recorder
            .require_free_slot()
            .expect("the slot is free once the owner is gone");
    }

    /// The heart of the interruption design: a dead stream ends the capture and
    /// nothing else. The audio is still there, the slot is still claimed, and the
    /// owner still decides what happens to it.
    #[test]
    fn a_dead_capture_keeps_the_recording_claimable_and_reaches_its_owner() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");
        assert!(recorder.is_recording());

        assert!(
            recorder
                .end_capture("1", EndedReason::DeviceDisconnected)
                .is_some(),
            "ending a capture must hand back the owner's channel so the host can tell it"
        );

        // The microphone is closed, so the tray must stop claiming otherwise,
        // and leaving its window no longer cuts a recording off.
        assert!(!recorder.is_capturing());
        assert!(!recorder.is_recording());

        // Everything else is unchanged: same recording, same owner, now carrying
        // the reason its capture ended.
        let held = recorder
            .active
            .as_ref()
            .expect("an ended recording is still held");
        assert_eq!(held.id, "1");
        assert_eq!(held.owner_label, "app-notes");
        assert_eq!(held.ended_reason, Some(EndedReason::DeviceDisconnected));
    }

    /// The invariant that makes the slot safe: nothing may start on top of a
    /// recording whose audio nobody has claimed yet.
    #[test]
    fn an_ended_recording_still_refuses_a_competing_start() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");

        let live = recorder
            .require_free_slot()
            .expect_err("a live recording refuses a start");
        assert_eq!(error_name(&live), "Busy");

        recorder.end_capture("1", EndedReason::PermissionRevoked);

        let ended = recorder
            .require_free_slot()
            .expect_err("an ended recording still holds the slot");
        assert_eq!(error_name(&ended), "Busy");
        // The two are distinguished in the message, because the remedies differ:
        // wait for a live recording, resolve an ended one.
        let RecorderError::Busy { message } = ended else {
            panic!("expected Busy");
        };
        assert!(
            message.contains("has ended"),
            "a Busy refusal must say the recording is waiting to be resolved: {message}"
        );
    }

    /// Stop is the one finalizing path, and it does not care whether the
    /// microphone is still open: the eight minutes captured before a device died
    /// come back through exactly the same call as a normal dictation.
    #[test]
    fn stopping_an_ended_recording_returns_what_it_captured() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");
        recorder.end_capture("1", EndedReason::DeviceDisconnected);

        let stopped = recorder
            .stop("1", "app-notes")
            .expect("an ended recording is still the owner's to stop");
        assert_eq!(stopped.duration_ms, 1_000, "the captured second survived");
        assert_eq!(samples_in(&root.path().join("1.webm")), TEST_RATE as usize);

        // And stopping resolved it, so the slot is free again.
        recorder
            .require_free_slot()
            .expect("a stopped recording releases the slot");
    }

    /// A non-owner must not be able to reach an ended recording either. The
    /// window that started it is the only one that can decide its audio's fate.
    #[test]
    fn a_non_owner_cannot_resolve_an_ended_recording() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");
        recorder.end_capture("1", EndedReason::DeviceDisconnected);

        let error = recorder
            .stop("1", "whispering")
            .expect_err("only the owner may claim the audio");
        assert_eq!(error_name(&error), "NotRecording");
        assert!(recorder.active.is_some());
    }

    /// A stream error can arrive after its recording was already resolved and
    /// the owner started another one. Matching on the id keeps the late failure
    /// from ending the innocent successor's capture, and makes a repeated report
    /// a no-op rather than a second notification.
    #[test]
    fn ending_the_capture_of_a_stale_id_leaves_the_held_recording_alone() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "2", "app-notes");

        assert!(recorder
            .end_capture("1", EndedReason::StreamFailed)
            .is_none());
        assert!(recorder.is_capturing());

        // The first report of a real failure reaches the owner; the second finds
        // the capture already ended and says nothing, so the owner is told once.
        assert!(recorder
            .end_capture("2", EndedReason::StreamFailed)
            .is_some());
        assert!(recorder
            .end_capture("2", EndedReason::DeviceDisconnected)
            .is_none());
        // And the first reason stands: a repeat report cannot rewrite history.
        assert_eq!(
            recorder.active.as_ref().and_then(|held| held.ended_reason),
            Some(EndedReason::StreamFailed)
        );
    }

    #[test]
    fn stopping_when_nothing_is_held_is_a_typed_refusal() {
        let mut recorder = Recorder::new();
        let error = recorder
            .stop("1", "app-notes")
            .expect_err("there is nothing to stop");
        assert_eq!(error_name(&error), "NotRecording");
    }

    /// `recover` must not finish the file a live recording is writing.
    #[test]
    fn the_held_recording_names_its_file() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");
        assert_eq!(recorder.held_path(), Some(staged_in(&root, "1").as_path()));
    }

    /// A disk that fills mid-recording ends the capture, and Stop answers
    /// with every whole second that reached the file, finished.
    #[test]
    fn a_full_disk_stops_with_what_reached_the_file() {
        use crate::webm::tests::FullDisk;
        let root = folder_root();
        let path = root.path().join("a.webm");
        let disk = FullDisk {
            file: File::create(&path).unwrap(),
            room: 8_000,
        };
        let mut capture = CaptureFile::open(path.clone(), disk, TEST_RATE).unwrap();
        let error = tone(TEST_RATE, 10)
            .chunks(441)
            .find_map(|chunk| capture.write(chunk).err())
            .expect("the disk filled");
        assert!(
            error.to_string().contains("No space left on device"),
            "{error}"
        );
        let finished = capture.finish().expect("what reached the file is kept");
        let kept = samples_in(&path);
        assert!(kept >= TEST_RATE as usize, "{kept} samples");
        assert_eq!(
            finished.duration_ms as usize,
            (kept * 1_000 + 8_000) / 16_000
        );
    }

    /// A capture whose writes never reached the file has nothing to finish.
    /// Stop says so, and the file is still not deleted.
    #[test]
    fn a_capture_that_wrote_nothing_fails_its_stop_and_leaves_the_file() {
        use crate::webm::tests::FullDisk;
        let root = folder_root();
        let path = root.path().join("a.webm");
        let disk = FullDisk {
            file: File::create(&path).unwrap(),
            room: 400,
        };
        let mut capture = CaptureFile::open(path.clone(), disk, TEST_RATE).unwrap();
        assert!(capture.write(&tone(TEST_RATE, 2)).is_err());
        let refused = capture.finish().unwrap_err();
        assert!(
            refused
                .to_string()
                .contains("nothing of it reached the disk"),
            "{refused}"
        );
        assert!(path.exists());
    }

    #[test]
    fn a_level_is_the_rms_since_the_last_one_sent_at_most_every_interval() {
        let mut level = Level::new();
        let start = level.last_sent;
        let later = start + MIC_LEVEL_EMIT_INTERVAL;
        assert_eq!(level.take(later), None, "nothing heard, nothing sent");
        level.add(&[16_384, -16_384]);
        assert_eq!(level.take(start), None, "not due yet");
        assert_eq!(level.take(later), Some(0.5));
        level.add(&[0, 0]);
        assert_eq!(
            level.take(later + MIC_LEVEL_EMIT_INTERVAL),
            Some(0.0),
            "the next level counts only what came after the last"
        );
    }

    #[test]
    fn downmix_stereo_to_mono_averages_pairs() {
        assert_eq!(downmix_f32(&[0.5, -0.5, 1.0, -1.0], 2), vec![0, 0]);
        assert_eq!(downmix_i16(&[1000, 2000, -400, -600], 2), vec![1500, -500]);
    }

    #[test]
    fn downmix_mono_converts_without_averaging() {
        // f32 scales into PCM16 and clamps rather than wrapping, which is the
        // difference between a loud passage and a burst of noise.
        assert_eq!(
            downmix_f32(&[0.0, 1.0, -1.0, 2.0, -2.0], 1),
            vec![0, i16::MAX, -i16::MAX, i16::MAX, -i16::MAX]
        );
        assert_eq!(downmix_i16(&[7, -7, 32_767], 1), vec![7, -7, 32_767]);
    }

    /// The bounded queue is the reason capture cannot be stalled by a disk, so
    /// what happens when it fills is worth pinning: the chunk is dropped and
    /// counted, and the callback returns rather than blocking.
    #[test]
    fn a_full_capture_queue_drops_chunks_instead_of_blocking() {
        let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<i16>>(2);
        let dropped = AtomicU32::new(0);

        for _ in 0..2 {
            assert!(sample_tx.try_send(vec![1, 2, 3]).is_ok());
        }
        assert!(
            sample_tx.try_send(vec![4, 5, 6]).is_err(),
            "the queue must be bounded, not merely large"
        );

        // What the callback does with that refusal.
        if sample_tx.try_send(vec![4, 5, 6]).is_err() {
            dropped.fetch_add(1, Ordering::Relaxed);
        }
        assert_eq!(dropped.load(Ordering::Relaxed), 1);

        // Draining makes room again, so a hiccup costs chunks rather than the
        // recording.
        drop(sample_rx.recv().expect("a queued chunk"));
        assert!(sample_tx.try_send(vec![7, 8, 9]).is_ok());
    }

    /// Whisper hallucinates sentences into near-silent clips shorter than about
    /// a second, so short recordings are padded to 1.25 s of the recording's
    /// rate.
    #[test]
    fn short_clips_are_padded_and_empty_ones_are_left_alone() {
        let root = folder_root();

        let short = capture_holding(&root, "a.webm", &[64; 100])
            .finish()
            .expect("finish a short clip");
        assert_eq!(short.duration_ms, 1_250);
        assert_eq!(samples_in(&short.path), 20_000);

        let empty = capture_holding(&root, "b.webm", &[])
            .finish()
            .expect("finish an empty clip");
        assert_eq!(
            empty.duration_ms, 0,
            "a recording that captured nothing must not be padded into looking real"
        );

        // Anything at or over a second is kept exactly as captured.
        let long = capture_holding(&root, "c.webm", &tone(TEST_RATE, 2))
            .finish()
            .expect("finish a long clip");
        assert_eq!(long.duration_ms, 2_000);
    }

    /// A microphone at another rate is converted as it is written: two seconds
    /// at 48 kHz are two seconds at the recording's rate.
    #[test]
    fn a_capture_from_a_device_at_another_rate_is_written_at_the_recording_rate() {
        let root = folder_root();
        let path = root.path().join("a.webm");
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let mut capture = CaptureFile::open(path.clone(), file, 48_000).unwrap();
        for chunk in tone(48_000, 2).chunks(480) {
            capture.write(chunk).unwrap();
        }
        let finished = capture.finish().unwrap();
        assert_eq!(finished.duration_ms, 2_000);
        assert_eq!(samples_in(&path), 2 * RECORDING_RATE as usize);
    }

    /// A stand-in for the cpal stream that delivers one last chunk as it closes.
    ///
    /// Real callbacks can fire while the device is being torn down, so the only
    /// thing that makes a drain complete is the sender being gone before the
    /// drain starts. This reproduces that ordering exactly: the farewell chunk
    /// is enqueued during `drop`, so a drain that ran *before* the stream closed
    /// would already have seen an empty queue and missed it.
    struct ClosingStream {
        sample_tx: Option<mpsc::SyncSender<Vec<i16>>>,
        farewell: Vec<i16>,
    }

    impl Drop for ClosingStream {
        fn drop(&mut self) {
            let sample_tx = self.sample_tx.take().expect("dropped once");
            let _ = sample_tx.try_send(std::mem::take(&mut self.farewell));
            // And the sender goes with it, which is what turns a later
            // `try_recv` from "nothing yet" into "nothing ever".
        }
    }

    /// The tail of every recording that stops during a backlog. The command
    /// channel has priority, so a stop can arrive with chunks the microphone
    /// already handed over still queued behind it. Finalizing without them
    /// truncates real speech, and because `try_send` accepted those chunks the
    /// drop counter would never have said so.
    ///
    /// The last quarter-second arrives *during* the close, which is the part a
    /// drain-then-close ordering silently loses.
    #[test]
    fn a_stop_writes_every_chunk_handed_over_including_during_the_close() {
        let root = folder_root();
        let mut capture = capture_holding(&root, "a.webm", &[]);
        let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<i16>>(CAPTURE_QUEUE_CHUNKS);

        // Three quarters of a second the callback delivered but the writer never
        // reached, then a final quarter delivered as the device closes.
        let queued = tone(TEST_RATE, 1);
        let (already_queued, during_close) = queued.split_at(TEST_RATE as usize * 3 / 4);
        for chunk in already_queued.chunks(512) {
            sample_tx
                .try_send(chunk.to_vec())
                .expect("room in the queue");
        }
        let stream = ClosingStream {
            sample_tx: Some(sample_tx),
            farewell: during_close.to_vec(),
        };

        close_capture_and_drain(stream, &mut capture, &sample_rx);

        let stopped = capture.finish().expect("finalize");
        assert_eq!(
            stopped.duration_ms, 1_000,
            "every accepted chunk must reach the file, including one enqueued while the stream closed"
        );
    }

    /// The drain waits for proof rather than for emptiness: only `Disconnected`
    /// says every sender is gone, and an empty queue with a live sender says
    /// nothing about what is about to arrive.
    #[test]
    fn a_closed_capture_channel_reports_disconnected_not_empty() {
        let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<i16>>(4);
        assert!(matches!(
            sample_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        drop(sample_tx);
        assert!(matches!(
            sample_rx.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
    }

    /// A sender that outlives the stream handle is the cpal macOS teardown race:
    /// its disconnect monitor can hold the last `Arc`, so the callback and its
    /// sender may be freed a moment after `drop(stream)` returns. The drain must
    /// keep taking chunks across that gap rather than stopping at the first
    /// empty poll, and must still return rather than wait forever.
    #[test]
    fn the_drain_waits_out_a_sender_that_outlives_the_stream_handle() {
        let root = folder_root();
        let mut capture = capture_holding(&root, "a.webm", &[]);
        let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<i16>>(CAPTURE_QUEUE_CHUNKS);

        // A second holder of the sender, standing in for cpal's monitor thread:
        // it delivers the last of the audio and closes only after the drain has
        // already found the queue empty once.
        let lingering = sample_tx.clone();
        let tail = tone(TEST_RATE, 1);
        let straggler = thread::spawn(move || {
            thread::sleep(Duration::from_millis(5));
            for chunk in tail.chunks(512) {
                lingering.try_send(chunk.to_vec()).expect("room");
            }
        });

        // Dropping the handle's own sender is not enough to end the drain.
        close_capture_and_drain(sample_tx, &mut capture, &sample_rx);
        straggler.join().expect("the straggler finished");

        let stopped = capture.finish().expect("finalize");
        assert_eq!(
            stopped.duration_ms, 1_000,
            "audio delivered while the stream was still closing must reach the file"
        );
    }

    /// And the wait is bounded: a sender that never closes gives up the tail
    /// rather than hanging the stop.
    #[test]
    fn the_drain_gives_up_on_a_capture_stream_that_never_closes() {
        let root = folder_root();
        let mut capture = capture_holding(&root, "a.webm", &tone(TEST_RATE, 2));
        let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<i16>>(CAPTURE_QUEUE_CHUNKS);

        let wedged = sample_tx.clone();
        let started = Instant::now();
        close_capture_and_drain(sample_tx, &mut capture, &sample_rx);
        let waited = started.elapsed();

        assert!(
            waited >= CAPTURE_CLOSE_TIMEOUT && waited < CAPTURE_CLOSE_TIMEOUT * 4,
            "the drain must give up on its own schedule, waited {waited:?}"
        );
        drop(wedged);

        let stopped = capture.finish().expect("finalize");
        assert_eq!(
            stopped.duration_ms, 2_000,
            "what was already written survives"
        );
    }

    /// The one-recorder invariant across a stop. `stop` runs the whole worker
    /// round trip, so by the time it returns the capture is closed and the
    /// worker has exited. The slot can never be observed free while a microphone
    /// is still open, because `&mut Recorder` exists only while the one recorder
    /// mutex is held.
    #[test]
    fn a_stop_closes_the_capture_before_the_slot_is_free() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");

        let stopped = recorder
            .stop("1", "app-notes")
            .expect("the owner may stop its recording");

        // The worker is gone, not merely asked to go, and only now is the slot
        // admissible again.
        assert!(recorder.active.is_none());
        recorder
            .require_free_slot()
            .expect("a stopped recording releases the slot");
        assert_eq!(stopped.duration_ms, 1_000);
        assert!(root.path().join(&stopped.path).exists());
    }
}
