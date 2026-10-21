//! CPAL recorder built around a two-thread pipeline.
//!
//! ```text
//! cpal callback thread            writer worker thread
//! ┌──────────────────────┐  chan  ┌──────────────────────┐
//! │ build_input_stream   │ ─────▶ │ run_capture          │
//! │  - downmix to mono   │ bound  │  - convert to 16 kHz │
//! │  - convert to PCM16  │   ed   │  - hound WavWriter   │
//! │  - try_send, or drop │        │  - pad short clips   │
//! │                      │        │  - send mic level    │
//! └──────────────────────┘        └──────────────────────┘
//! ```
//!
//! The cpal callback never blocks and never touches a file: it downmixes to
//! mono, converts to PCM16, and hands the chunk to a **bounded** channel with
//! `try_send`. A full channel drops the chunk, which is the only outcome that
//! keeps a stalled disk from stalling the audio thread.
//!
//! The worker writes those chunks straight into the recording's WAV as they
//! arrive, so memory is flat in the recording's length rather than
//! proportional to it. An hour-long meeting costs the same resident audio as a
//! four-second dictation: one bounded queue and one `BufWriter`. That is the
//! whole reason this path exists, and it is why there is no separate long-form
//! mode for an application to select.
//!
//! # A recording is its file in the folder from the first sample
//!
//! The WAV is created at its final path in the folder when the recording
//! starts and appended to in place: the one data file not staged and renamed
//! (ADR-0543). Its header is brought up to date about once a second and
//! exactly when `stop` finalizes it, so a process that ends mid-recording
//! leaves every sample that reached the file behind a header that undercounts
//! at most the last second; `wav::recover` rewrites such a header from the
//! file's length the next time the folder opens. Nothing deletes the file but
//! `cancel`.
//!
//! # The microphone keeps its rate; the file is 16 kHz
//!
//! The microphone is opened at the rate and format it already runs at
//! ([`input_config`]). Asking a macOS device for another rate sets that
//! device's nominal rate for every process using it, and it stays set after
//! the stream closes, so a call in progress on the same microphone would go
//! silent. The writer converts each chunk to 16 kHz mono PCM16 instead
//! ([`crate::rate`]): the rate local transcription reads, and a third of the
//! bytes a 48 kHz file would send to a cloud transcription endpoint, whose
//! upload caps are in megabytes.
//!
//! # One recorder, owned by the window that started it
//!
//! There is exactly one recorder for the whole host, and at most one
//! recording in flight. A recording is addressed by the id the host minted
//! for it and is owned by the window label that started it. Every lifecycle
//! method takes both, so an application can only ever stop or cancel the
//! recording it actually started: a competing `start` is refused with
//! [`RecorderError::Busy`] rather than silently displacing the live one.
//!
//! A window whose page reloads or closes can no longer stop its recording, so
//! the host finalizes it for that window ([`Recorder::finish_owned_by`]): the
//! audio is kept, and the slot is free for the next page.
//!
//! # An ended recording is still the owner's to claim
//!
//! Capture can stop without anyone asking: the microphone is unplugged, a
//! permission is withdrawn, the stream dies. That releases the *device*, not the
//! *recording*. [`Recorder::end_capture`] marks the recording ended, drops the
//! cpal stream, and leaves everything else exactly where it was: the slot stays
//! occupied and the file stays as capture left it.
//!
//! That is the whole interruption design. There is no pending-interruption
//! inbox, no acknowledgement, no restore call, and no second channel that pushes
//! audio at the owner. `stop` remains the one path that finalizes a file and
//! `cancel` remains the one path that deletes it, whether or not capture is
//! still running when they are called. A competing `start` stays [`Busy`] until
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
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use log::{debug, error, info, warn};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
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
use crate::rate::RateConverter;

/// Recorder result type. Errors cross the IPC boundary as the internally
/// tagged `RecorderError` enum (`{ name, message }`) so the JS side switches
/// on `error.name` instead of matching message text.
pub type Result<T> = std::result::Result<T, RecorderError>;

/// The rate every recording is written at, whatever rate its microphone runs
/// at: the rate local transcription reads, so it reads a recording without
/// converting it again.
pub(crate) const RECORDING_RATE: u32 = 16_000;

/// Bytes one PCM16 sample occupies in the recording's file.
const BYTES_PER_SAMPLE: u32 = 2;

/// The most audio bytes one WAV can describe.
///
/// RIFF states its sizes in 32 bits, and `hound` counts written bytes in a `u32`
/// it increments without checking, so a recording long enough to overflow it
/// would silently wrap the header rather than fail. The writer refuses first.
/// `36` is the header those bytes are added to (`update_header` in hound 3.5.1
/// computes `data_len_offset + 4 - 8`, which is 36 for the PCM `fmt ` chunk this
/// spec produces).
///
/// At 16 kHz mono PCM16 the ceiling is about 37 hours, well past any meeting
/// this path is meant to carry, so it is a guard rail rather than a mode.
const MAX_WAV_DATA_BYTES: u32 = u32::MAX - 36;

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

/// How often the header is brought up to the samples written so far.
///
/// The file is the recording while it runs: a commit, a copy, or a player
/// reading it mid-recording reads what the header states, and so does a quit
/// that cuts the recording off before `recover` repairs it. Each update is one
/// seek and two small writes; once a second keeps what a reader misses to at
/// most that second.
const HEADER_UPDATE_INTERVAL: Duration = Duration::from_secs(1);

/// Whether appending `samples` more would take the file past what a WAV header
/// can describe.
///
/// Widened to `u64` for the arithmetic, because the whole point is that the
/// 32-bit answer is the one that lies.
fn would_exceed_wav_limit(written_samples: u32, samples: usize) -> bool {
    // Saturating throughout: every way this arithmetic can wrap produces a
    // smaller number, which is the one direction that would answer "there is
    // room" for a chunk there is no room for.
    (written_samples as u64)
        .saturating_add(samples as u64)
        .saturating_mul(BYTES_PER_SAMPLE as u64)
        > MAX_WAV_DATA_BYTES as u64
}

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
/// `Stop` asks the worker to finalize the file and `Cancel` deletes it; both
/// end the worker. `EndCapture` ends neither: it tells the worker its capture
/// is over so it can release the microphone and wait, still holding the file,
/// for the owner to stop or cancel it.
#[derive(Debug)]
enum RecorderCmd {
    Stop(mpsc::Sender<Result<FinishedRecording>>),
    Cancel(mpsc::Sender<Result<()>>),
    EndCapture,
}

/// The WAV one capture is writing into, at its path in the folder.
///
/// Owned entirely by the worker thread, which is what lets the writer stay
/// unsynchronized: nothing else in this process writes the file, so there is
/// no lock between the audio path and the bytes.
struct CaptureFile {
    path: PathBuf,
    /// `None` only after finalization, so the writer can be consumed by value
    /// without leaving a half-alive one behind.
    writer: Option<WavWriter<BufWriter<File>>>,
    /// From the microphone's rate to [`RECORDING_RATE`]; `None` when they are
    /// the same, and after the stream's tail is written.
    converter: Option<Box<RateConverter>>,
    write_failed: bool,
}

impl CaptureFile {
    /// Start the WAV for a recording about to start, in the file just created
    /// for it.
    ///
    /// Mono PCM16 at [`RECORDING_RATE`], from samples at `device_rate`. Mono
    /// because a dictation microphone is one voice and the transcriber
    /// downmixes anyway; PCM16 because it halves the file against f32 at a
    /// noise floor two orders of magnitude below anything a microphone
    /// produces.
    fn open(path: PathBuf, file: File, device_rate: u32) -> Result<Self> {
        let converter = if device_rate == RECORDING_RATE {
            None
        } else {
            match RateConverter::new(device_rate, RECORDING_RATE) {
                Ok(converter) => Some(Box::new(converter)),
                Err(error) => {
                    if let Err(cleanup) = remove_recording(&path) {
                        warn!("{cleanup}");
                    }
                    return Err(error);
                }
            }
        };
        let spec = WavSpec {
            channels: 1,
            sample_rate: RECORDING_RATE,
            bits_per_sample: 16,
            sample_format: WavSampleFormat::Int,
        };
        match WavWriter::new(BufWriter::new(file), spec) {
            Ok(writer) => Ok(Self {
                path,
                writer: Some(writer),
                converter,
                write_failed: false,
            }),
            // A file nothing can write a header to is debris, not a recording
            // waiting to happen.
            Err(error) => {
                if let Err(cleanup) = remove_recording(&path) {
                    warn!("{cleanup}");
                }
                Err(RecorderError::failed(format!(
                    "open wav writer {}: {error}",
                    path.display()
                )))
            }
        }
    }

    /// Append one callback's worth of mono PCM16 at the microphone's rate.
    ///
    /// The worker buffers samples; only Stop finalizes the WAV header.
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
        let Some(writer) = self.writer.as_mut() else {
            return Err(RecorderError::failed("the recording is already finalized"));
        };
        if would_exceed_wav_limit(writer.len(), samples.len()) {
            return Err(RecorderError::failed(
                "the recording reached the longest audio a WAV file can describe",
            ));
        }
        for &sample in samples {
            writer
                .write_sample(sample)
                .map_err(|error| RecorderError::failed(format!("write the recording: {error}")))?;
        }
        Ok(())
    }

    /// State the samples written so far in the header, and flush them.
    ///
    /// A failure here is a failure to write, and ends the capture as one.
    fn update_header(&mut self) -> Result<()> {
        let Some(writer) = self.writer.as_mut() else {
            return Err(RecorderError::failed("the recording is already finalized"));
        };
        let updated = writer.flush().map_err(|error| {
            RecorderError::failed(format!("update the recording's header: {error}"))
        });
        if updated.is_err() {
            self.write_failed = true;
        }
        updated
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
        let captured = self.writer.as_ref().map_or(0, |writer| writer.len());
        if captured == 0 || captured >= RECORDING_RATE {
            return Ok(());
        }
        let target = RECORDING_RATE + RECORDING_RATE / 4;
        let padding = vec![0i16; (target - captured) as usize];
        self.write_samples(&padding)
    }

    /// Finalize the WAV in place and report how long it is.
    ///
    /// A capture whose writes failed keeps the prefix that reached the file:
    /// its header is rewritten from the file's length, as `wav::recover` would
    /// on the next open, rather than from a count the failed writer can no
    /// longer vouch for. Nothing here deletes the file.
    fn finish(mut self) -> Result<FinishedRecording> {
        let finalized = if self.write_failed {
            Err(RecorderError::failed(
                "the recording could not be written to the end",
            ))
        } else {
            self.finalize_wav()
        };
        let duration_ms = match finalized {
            // Exact duration of what was written: the file's own sample count
            // over the rate it was captured at. Bounded by the RIFF ceiling the
            // writer enforces, so it always fits in `u32`.
            Ok(sample_count) => {
                (sample_count as f64 / RECORDING_RATE as f64 * 1000.0).round() as u32
            }
            Err(error) => {
                // Dropped before the repair, so a buffered tail lands first.
                drop(self.writer.take());
                warn!(
                    "Recording {} did not finalize cleanly: {error}",
                    self.path.display()
                );
                match crate::wav::repair(&self.path) {
                    Ok(Some(repaired)) => repaired.duration_ms,
                    Ok(None) => {
                        return Err(RecorderError::failed(format!(
                            "{error}; {} is not a WAV whose header can be repaired",
                            self.path.display()
                        )))
                    }
                    Err(repair) => {
                        return Err(RecorderError::failed(format!(
                            "{error}; its header could not be repaired: {repair}"
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

    fn finalize_wav(&mut self) -> Result<u32> {
        self.write_tail()?;
        self.pad_if_short()?;
        let Some(writer) = self.writer.take() else {
            return Err(RecorderError::failed("the recording is already finalized"));
        };
        // Read before `finalize` consumes the writer. This is the count hound
        // will stamp into the header, and it counts only samples the writer
        // accepted.
        let sample_count = writer.len();
        // Checked, never left to `Drop`. hound patches the header on drop too,
        // but a drop cannot report that the patch failed, and an unreported
        // failure here is a header that undercounts the recording. A
        // successful `finalize` also flushes, so every counted byte is on disk
        // by the time this returns.
        writer
            .finalize()
            .map_err(|error| RecorderError::failed(format!("finalize the recording: {error}")))?;
        Ok(sample_count)
    }

    /// Delete the recording without finalizing it.
    ///
    /// Drop the encoder first so it cannot patch a WAV after the file is gone.
    fn discard(mut self) -> Result<()> {
        drop(self.writer.take());
        remove_recording(&self.path)
    }
}

/// Remove a recording's file, which only `cancel` and a capture that never
/// started do. A file already gone is not a failure.
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

/// A finalized recording: its file and how long it is.
///
/// The capture behind it is closed: its microphone is released, its worker has
/// exited, and its bytes are complete on disk behind a header that states them.
#[derive(Debug)]
pub struct FinishedRecording {
    pub path: PathBuf,
    pub duration_ms: u32,
}

/// What `start` answers: the id to stop or cancel the recording by, the file
/// it is writing, and the microphone it opened.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartedRecording {
    pub id: String,
    /// The folder-relative path of the WAV, the path the page named plus `.wav`.
    pub path: String,
    /// The name of the microphone that is recording.
    pub device: String,
}

/// What `stop` answers: the finalized file and its length.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StoppedRecording {
    /// The folder-relative path of the WAV.
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
    /// The recording's file, absolute, which `recover` leaves alone.
    path: PathBuf,
    /// The same file, folder-relative, as the page named it.
    relative: String,
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
    pub fn page_ended(&mut self, owner: &str) -> (Option<FinishedRecording>, bool) {
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
    /// its audio is the owner's until it stops or cancels it, and quietly
    /// finalizing it to make room would take that decision away.
    ///
    /// The device is resolved here rather than by the caller. `requested_device`
    /// is the id of the microphone the person chose; when none with that id
    /// is connected this refuses with [`RecorderError::InputUnavailable`]
    /// rather than opening another, because recording from a microphone the
    /// person did not choose is not what they asked for. `None` is the system
    /// default.
    ///
    /// `target` is the checked absolute path of the WAV in its folder and
    /// `relative` the same path as the page named it. The file is created only
    /// after the device and its configuration resolve, and never over anything
    /// already there.
    ///
    /// The cpal stream is built inside the worker (macOS requires the stream and
    /// the run loop driving it to share a thread) and its outcome is reported
    /// back over `ready_rx`, so a stream that fails to open surfaces as the real
    /// classified error rather than as a dropped channel.
    pub fn start(
        &mut self,
        requested_device: Option<&str>,
        target: PathBuf,
        relative: String,
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
            .open(&target)
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::AlreadyExists => {
                    RecorderError::refused(format!("a file is already at {relative}"))
                }
                _ => RecorderError::failed(format!("create {relative}: {error}")),
            })?;
        let capture = CaptureFile::open(target.clone(), file, device_rate)?;

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
                await_resolution(capture, &cmd_rx);
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
            "Recording started: id={id}, owner={owner_label}, path={relative}, device={device_name}, {device_rate} Hz, {device_channels} channels",
        );
        self.active = Some(HeldRecording {
            id: id.clone(),
            owner_label,
            path: target,
            relative: relative.clone(),
            ended_reason: None,
            signals,
            cmd_tx,
            worker,
        });
        Ok(StartedRecording {
            id,
            path: relative,
            device: device_name,
        })
    }

    /// Mark the recording named by `id` as ended because its capture stopped
    /// on its own, returning its owner's channel so the host can tell it.
    ///
    /// This ends the *capture*, not the recording. The worker releases the
    /// microphone and keeps everything it captured, and the slot stays
    /// occupied. Only the owner decides what happens to the audio, through
    /// `stop` or `cancel`.
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

    /// Stop the recording named by `id` and finalize its file. Restricted to
    /// the window that started it.
    ///
    /// Works the same whether capture is still running or already ended. That is
    /// the point of holding an ended recording: `stop` is the one finalizing
    /// path, so the audio captured before a microphone died is reached by the
    /// same call as the audio captured before the person let go of the button.
    pub fn stop(&mut self, id: &str, caller_label: &str) -> Result<StoppedRecording> {
        self.require_owned(id, caller_label)?;
        let active = self.active.take().expect("ownership was just verified");
        let relative = active.relative.clone();
        finish(active).map(|finished| StoppedRecording {
            path: relative,
            duration_ms: finished.duration_ms,
        })
    }

    /// Cancel the recording named by `id`, deleting its file.
    ///
    /// Restricted to the owner window, for the same reason `stop` is: a
    /// recording another window is relying on must not vanish under it.
    /// Removal failures are reported after the microphone and recorder slot
    /// are released; a file already gone counts as removed.
    pub fn cancel(&mut self, id: &str, caller_label: &str) -> Result<()> {
        self.require_owned(id, caller_label)?;
        let active = self.active.take().expect("ownership was just verified");
        discard(active)
    }

    /// Finalize the held recording if `owner_label` owns it. The host's own
    /// path, used when the owner's page is gone: nobody can stop the recording
    /// now, so holding the single recorder slot for it would wedge every other
    /// window, and deleting it would lose what the person said.
    pub fn finish_owned_by(&mut self, owner_label: &str) -> Option<FinishedRecording> {
        let active = self
            .active
            .take_if(|active| active.owner_label == owner_label)?;
        let id = active.id.clone();
        match finish(active) {
            Ok(finished) => {
                info!("Recording {id} finalized because its page is gone");
                Some(finished)
            }
            Err(error) => {
                warn!("Recording {id} could not be finalized after its page left: {error}");
                None
            }
        }
    }

    /// Finalize whatever recording is held, for the app's exit.
    pub fn finish_held(&mut self) {
        if let Some(active) = self.active.take() {
            let _ = finish(active);
        }
    }

    /// Whether a microphone is open right now, by the recording or a meter,
    /// for the host's tray indicator.
    ///
    /// Deliberately not "is the slot occupied". A recording whose capture died
    /// still holds the slot, but nothing is being captured, and a tray that kept
    /// claiming otherwise would be lying about the microphone.
    pub fn is_capturing(&self) -> bool {
        !self.meters.is_empty()
            || self
                .active
                .as_ref()
                .is_some_and(|active| active.ended_reason.is_none())
    }

    /// The file of the held recording, which `recover` must not rewrite.
    pub fn held_path(&self) -> Option<PathBuf> {
        self.active.as_ref().map(|active| active.path.clone())
    }

    /// The one admission rule, in one place: the slot must be empty.
    ///
    /// A recording whose capture already ended still occupies it. Reporting that
    /// distinctly matters because the two look identical from outside and have
    /// different remedies: waiting out a live recording, versus stopping or
    /// cancelling one that is over.
    ///
    /// Sits beside [`Recorder::require_owned`] rather than inline in `start`,
    /// because these are the recorder's two access rules and reading them
    /// together is how the slot's whole policy stays legible.
    fn require_free_slot(&self) -> Result<()> {
        let Some(active) = &self.active else {
            return Ok(());
        };
        let state = match active.ended_reason {
            None => "is already in flight",
            Some(_) => "has ended and is waiting to be stopped or cancelled",
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
                "no recording is held; '{id}' has already been stopped or cancelled"
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

/// End a recording and keep it: tell the worker to finalize the file, then
/// join it so the cpal stream is released before returning.
///
/// The slot is unavailable for the whole round trip, because the caller's
/// `&mut Recorder` comes from the one recorder mutex and nothing else can
/// acquire it until this returns. That is load-bearing: the worker is still
/// holding an open cpal stream until it answers, and a `start` that slipped in
/// beforehand would open a second microphone against a recorder that is
/// supposed to have exactly one.
fn finish(active: HeldRecording) -> Result<FinishedRecording> {
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
    finished
}

/// Tell the worker to remove the recording, then join it so the cpal stream
/// is released before returning, whether or not the removal succeeded.
fn discard(active: HeldRecording) -> Result<()> {
    let (reply_tx, reply_rx) = mpsc::channel();
    let cancelled = match active.cmd_tx.send(RecorderCmd::Cancel(reply_tx)) {
        Ok(()) => reply_rx
            .recv()
            .map_err(|error| {
                RecorderError::failed(format!(
                    "Worker dropped the cancel reply for {}: {error}",
                    active.id
                ))
            })
            .and_then(|result| result),
        Err(error) => Err(RecorderError::failed(format!(
            "Failed to send cancel command: {error}"
        ))),
    };
    // Release the microphone and the worker even when deleting the file failed.
    let _ = active.worker.join();
    if cancelled.is_ok() {
        debug!("Recording {} cancelled", active.id);
    }
    cancelled
}

/// A recorder going away keeps what it holds: the file is finalized, never
/// deleted.
impl Drop for Recorder {
    fn drop(&mut self) {
        self.finish_held();
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
    /// The owner already resolved the recording: a `Stop` finalized the file,
    /// or a `Cancel` answered its removal. Nothing is left to wait for.
    Resolved,
    /// Capture ended with the recording still unclaimed. The file is as
    /// capture left it and its owner may still stop or cancel it.
    Unclaimed(CaptureFile),
}

/// Capture phase. Writes mono PCM16 into the recording's WAV as it arrives,
/// sending a throttled RMS level to the owner's page so its meter can reflect
/// live mic activity.
///
/// The capture file is passed by value because whichever way this ends, it
/// ends here: a `Stop` finalizes it, a `Cancel` deletes it, and anything else
/// hands it back to be waited on.
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
    let mut last_header_update = Instant::now();

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
            Ok(RecorderCmd::Cancel(reply)) => {
                drop(stream);
                let _ = reply.send(capture.discard());
                return CaptureOutcome::Resolved;
            }
            // Capture is over but the recording is not: hand the file up so it
            // can wait for the owner to stop or cancel it.
            Ok(RecorderCmd::EndCapture) => {
                close_capture_and_drain(stream, &mut capture, &sample_rx);
                report_dropped_chunks(dropped_chunks, id);
                return CaptureOutcome::Unclaimed(capture);
            }
            // The command sender is gone without a stop or a cancel, so nobody
            // is left to claim this recording. It is kept, finalized.
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

                let written = capture.write(&samples).and_then(|()| {
                    if last_header_update.elapsed() < HEADER_UPDATE_INTERVAL {
                        return Ok(());
                    }
                    last_header_update = Instant::now();
                    capture.update_header()
                });
                if let Err(error) = written {
                    // A write that fails is terminal: the disk is full, the
                    // volume vanished, or the recording hit the size a WAV can
                    // describe. None of those get better by trying again, so the
                    // capture ends here and the recording keeps whatever prefix
                    // reached the file.
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
                    return CaptureOutcome::Unclaimed(capture);
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
                return CaptureOutcome::Unclaimed(capture);
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
            Ok(RecorderCmd::Cancel(reply)) => {
                let _ = reply.send(capture.discard());
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
    use hound::WavReader;
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
        for name in ["first.wav", "second.wav"] {
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
            let reader = WavReader::open(&finished.path).unwrap();
            let samples = reader.len();
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
            assert_eq!(reader.spec().sample_rate, RECORDING_RATE);
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
    /// once its capture has ended, so `stop` here finalizes an actual WAV
    /// rather than a mock of one, and `discard`'s `Cancel`-then-join cannot
    /// hang: `await_resolution` returns on `Cancel` and on a dropped channel.
    fn recording_owned_by(recorder: &mut Recorder, root: &TempDir, id: &str, owner_label: &str) {
        let name = format!("{id}.wav");
        hold_recording(
            recorder,
            &root.path().join(&name),
            &format!("recordings/{name}"),
            id,
            owner_label,
        );
    }

    /// Hold a one-second recording at `path` for `owner_label`, as `start`
    /// would have, without a microphone. The plugin's own tests use it too.
    pub(crate) fn hold_recording(
        recorder: &mut Recorder,
        path: &Path,
        relative: &str,
        id: &str,
        owner_label: &str,
    ) {
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(path)
            .expect("create the recording");
        let mut capture =
            CaptureFile::open(path.to_path_buf(), file, TEST_RATE).expect("open the capture");
        capture
            .write(&tone(TEST_RATE, 1))
            .expect("write the capture");
        let (cmd_tx, cmd_rx) = mpsc::channel::<RecorderCmd>();
        let worker = thread::spawn(move || await_resolution(capture, &cmd_rx));
        recorder.active = Some(HeldRecording {
            id: id.to_string(),
            owner_label: owner_label.to_string(),
            path: path.to_path_buf(),
            relative: relative.to_string(),
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

    /// The samples the WAV at `path` says it holds, read back with hound.
    fn samples_in(path: &Path) -> u32 {
        WavReader::open(path).expect("a readable WAV").len()
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

    /// The point of writing in place: what a capture wrote is the recording's
    /// file before anyone stops it, and a stop only states its sizes.
    #[test]
    fn a_recording_is_its_file_from_the_first_sample() {
        let root = folder_root();
        let mut capture = capture_holding(&root, "a.wav", &tone(TEST_RATE, 1));
        capture.update_header().unwrap();
        let path = root.path().join("a.wav");
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            44 + TEST_RATE as u64 * 2,
            "every sample written is already in the file"
        );
        assert_eq!(
            samples_in(&path),
            TEST_RATE,
            "an update states the sizes so far"
        );
        let finished = capture.finish().unwrap();
        assert_eq!(finished.path, path);
        assert_eq!(finished.duration_ms, 1_000);
        assert_eq!(samples_in(&path), TEST_RATE);
    }

    /// A page that reloads or closes cannot stop its recording, so the host
    /// finalizes it: the audio is kept and the slot is free. The page count
    /// moves on, which is what refuses a `start` the departed page sent late.
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

        let finished = recorder
            .page_ended("app-notes")
            .0
            .expect("the departed page's recording is finalized");
        assert_eq!(finished.duration_ms, 1_000);
        assert_eq!(samples_in(&root.path().join("1.wav")), TEST_RATE);
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
        assert_eq!(samples_in(&root.path().join("1.wav")), TEST_RATE);
    }

    #[test]
    fn a_non_owner_cannot_stop_or_cancel_and_the_recording_survives() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");

        let stop = recorder
            .stop("1", "whispering")
            .expect_err("a non-owner must not stop another window's recording");
        assert_eq!(error_name(&stop), "NotRecording");

        let cancel = recorder
            .cancel("1", "whispering")
            .expect_err("a non-owner must not cancel another window's recording");
        assert_eq!(error_name(&cancel), "NotRecording");

        // The refusals left the owner's recording completely untouched.
        assert!(recorder.is_capturing());
        assert!(root.path().join("1.wav").exists());
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

    /// Cancel is the one path that deletes a recording.
    #[test]
    fn the_owner_can_cancel_and_the_file_is_gone() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");

        recorder
            .cancel("1", "app-notes")
            .expect("the owner may cancel its own recording");

        assert!(!recorder.is_capturing());
        assert!(!root.path().join("1.wav").exists());
        recorder.require_free_slot().unwrap();
    }

    #[test]
    fn cancel_reports_a_failed_removal_and_releases_the_recorder() {
        for ended in [false, true] {
            let root = folder_root();
            let mut recorder = Recorder::new();
            recording_owned_by(&mut recorder, &root, "1", "app-notes");
            if ended {
                recorder.end_capture("1", EndedReason::StreamFailed);
            }

            // A directory cannot be removed as a file on any test user's permissions.
            // Keep the actual audio beside it, rather than deleting the fixture's input.
            let path = root.path().join("1.wav");
            let preserved = root.path().join("preserved.wav");
            std::fs::rename(&path, &preserved).unwrap();
            std::fs::create_dir(&path).unwrap();

            let error = recorder
                .cancel("1", "app-notes")
                .expect_err("cancel must report that its file could not be removed");
            assert_eq!(error_name(&error), "Failed");
            assert!(
                error.to_string().contains("remove the recording"),
                "{error}"
            );
            assert!(error.to_string().contains("1.wav"), "{error}");
            assert!(path.is_dir(), "a refused removal leaves the path untouched");
            assert!(preserved.is_file(), "the audio is not lost");
            assert!(!recorder.is_capturing());
            assert!(recorder.held_path().is_none());
            recorder
                .require_free_slot()
                .expect("a failed removal releases the slot");

            recording_owned_by(&mut recorder, &root, "2", "app-notes");
            recorder.cancel("2", "app-notes").unwrap();
        }
    }

    #[test]
    fn a_live_capture_reports_failed_cancel_after_releasing_its_stream() {
        let root = folder_root();
        let capture = capture_holding(&root, "1.wav", &tone(TEST_RATE, 1));
        let path = root.path().join("1.wav");
        std::fs::rename(&path, root.path().join("preserved.wav")).unwrap();
        std::fs::create_dir(&path).unwrap();
        let (_sample_tx, sample_rx) = mpsc::sync_channel(CAPTURE_QUEUE_CHUNKS);
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (reply_tx, reply_rx) = mpsc::channel();
        cmd_tx.send(RecorderCmd::Cancel(reply_tx)).unwrap();
        let stream = Arc::new(());
        let dropped = AtomicU32::new(0);

        let outcome = run_capture(
            sample_rx,
            &cmd_rx,
            capture,
            stream.clone(),
            CaptureContext {
                id: "1",
                dropped_chunks: &dropped,
                signals: no_page(),
                on_ended: Arc::new(|_, _| panic!("an explicit cancel is not an interruption")),
            },
        );

        assert!(matches!(outcome, CaptureOutcome::Resolved));
        assert_eq!(Arc::strong_count(&stream), 1, "the stream was released");
        let error = reply_rx.recv().unwrap().expect_err("removal failed");
        assert_eq!(error_name(&error), "Failed");
    }

    #[test]
    fn cancel_accepts_a_recording_file_that_is_already_gone() {
        for ended in [false, true] {
            let root = folder_root();
            let mut recorder = Recorder::new();
            recording_owned_by(&mut recorder, &root, "1", "app-notes");
            if ended {
                recorder.end_capture("1", EndedReason::StreamFailed);
            }
            std::fs::remove_file(root.path().join("1.wav")).unwrap();
            recorder
                .cancel("1", "app-notes")
                .expect("already removed is cancelled");
            assert!(recorder.held_path().is_none());
            recorder.require_free_slot().unwrap();
        }
    }

    #[test]
    fn stop_answers_the_folder_relative_path_and_keeps_the_file() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");

        let stopped = recorder.stop("1", "app-notes").unwrap();
        assert_eq!(stopped.path, "recordings/1.wav");
        assert_eq!(stopped.duration_ms, 1_000);
        assert_eq!(samples_in(&root.path().join("1.wav")), TEST_RATE);

        let again = recorder
            .stop("1", "app-notes")
            .expect_err("there is nothing left to stop");
        assert_eq!(error_name(&again), "NotRecording");
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
        assert_eq!(samples_in(&root.path().join("1.wav")), TEST_RATE);
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

        assert!(
            recorder
                .end_capture("1", EndedReason::DeviceDisconnected)
                .is_some(),
            "ending a capture must hand back the owner's channel so the host can tell it"
        );

        // The microphone is closed, so the tray must stop claiming otherwise.
        assert!(!recorder.is_capturing());

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
        assert_eq!(samples_in(&root.path().join("1.wav")), TEST_RATE);

        // And stopping resolved it, so the slot is free again.
        recorder
            .require_free_slot()
            .expect("a stopped recording releases the slot");
    }

    #[test]
    fn cancelling_an_ended_recording_deletes_it() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");
        recorder.end_capture("1", EndedReason::StreamFailed);

        recorder
            .cancel("1", "app-notes")
            .expect("the owner may cancel an ended recording");
        assert!(recorder.active.is_none());
        assert!(!root.path().join("1.wav").exists());
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

    /// `recover` must not rewrite the file a live recording is writing.
    #[test]
    fn the_held_recording_names_its_file() {
        let root = folder_root();
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, &root, "1", "app-notes");
        assert_eq!(recorder.held_path(), Some(root.path().join("1.wav")));
    }

    /// A write that fails keeps the prefix that reached the file. The header
    /// is rewritten from the file's length, so the recording reads as what was
    /// written rather than as a count the failed writer kept.
    #[test]
    fn a_failed_write_keeps_the_prefix_that_reached_the_file() {
        let root = folder_root();
        let mut capture = capture_holding(&root, "a.wav", &tone(TEST_RATE, 1));
        capture.write_failed = true;
        let finished = capture.finish().expect("the prefix is a recording");
        assert_eq!(finished.duration_ms, 1_000);
        assert_eq!(samples_in(&root.path().join("a.wav")), TEST_RATE);
    }

    /// A capture whose writes never reached the file has nothing to repair.
    /// Stop says so, and the file is still not deleted: only `cancel` does that.
    #[test]
    fn a_capture_that_wrote_nothing_fails_its_stop_and_leaves_the_file() {
        let root = folder_root();
        let path = root.path().join("a.wav");
        std::fs::write(&path, []).unwrap();
        let file = File::open(&path).unwrap();
        let mut capture = CaptureFile::open(path.clone(), file, TEST_RATE).unwrap();
        assert!(capture.write(&tone(TEST_RATE, 1)).is_err());
        assert!(capture.finish().is_err());
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

        let short = capture_holding(&root, "a.wav", &[64; 100])
            .finish()
            .expect("finish a short clip");
        assert_eq!(short.duration_ms, 1_250);

        let empty = capture_holding(&root, "b.wav", &[])
            .finish()
            .expect("finish an empty clip");
        assert_eq!(
            empty.duration_ms, 0,
            "a recording that captured nothing must not be padded into looking real"
        );

        // Anything at or over a second is kept exactly as captured.
        let long = capture_holding(&root, "c.wav", &tone(TEST_RATE, 2))
            .finish()
            .expect("finish a long clip");
        assert_eq!(long.duration_ms, 2_000);
    }

    /// A microphone at another rate is converted as it is written: two seconds
    /// at 48 kHz are two seconds at the recording's rate.
    #[test]
    fn a_capture_from_a_device_at_another_rate_is_written_at_the_recording_rate() {
        let root = folder_root();
        let path = root.path().join("a.wav");
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
        let reader = WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().sample_rate, RECORDING_RATE);
        assert_eq!(reader.len(), 2 * RECORDING_RATE);
    }

    /// A finished recording is a canonical PCM WAV at the recording's rate,
    /// whose samples are the ones written.
    #[test]
    fn a_finished_capture_is_a_canonical_wav_of_what_was_written() {
        let root = folder_root();
        let finished = capture_holding(&root, "a.wav", &tone(TEST_RATE, 1))
            .finish()
            .expect("finish the capture");
        assert_eq!(finished.duration_ms, 1_000);

        let bytes = std::fs::read(&finished.path).expect("read the recording");
        // 44-byte canonical PCM header plus one second of 16 kHz mono PCM16.
        assert_eq!(bytes.len(), 44 + (TEST_RATE as usize * 2));

        let reader = WavReader::open(&finished.path).unwrap();
        assert_eq!(reader.spec().sample_rate, TEST_RATE);
        assert_eq!(reader.spec().channels, 1);
        let samples: Vec<i16> = reader
            .into_samples()
            .map(|sample| sample.unwrap())
            .collect();
        assert_eq!(samples, tone(TEST_RATE, 1));
    }

    /// RIFF describes its sizes in 32 bits and hound increments its byte counter
    /// without checking, so a recording long enough to overflow it would wrap
    /// the header into describing a few bytes instead of four gigabytes. The
    /// writer refuses first, which turns a corrupt file into a typed failure.
    ///
    /// Asserted as arithmetic. Reaching the boundary for real means writing four
    /// gigabytes, which a test suite may not do, and the boundary is the whole
    /// thing being checked.
    #[test]
    fn a_capture_refuses_to_exceed_what_a_wav_can_describe() {
        let limit = MAX_WAV_DATA_BYTES / BYTES_PER_SAMPLE;

        assert!(!would_exceed_wav_limit(0, limit as usize));
        assert!(would_exceed_wav_limit(0, limit as usize + 1));
        assert!(!would_exceed_wav_limit(limit - 1, 1));
        assert!(would_exceed_wav_limit(limit, 1));
        // A ridiculous chunk cannot wrap its way back under the ceiling.
        assert!(would_exceed_wav_limit(limit, usize::MAX));

        // Over twelve hours of mono capture, so this caps a runaway recording
        // rather than interrupting a meeting.
        assert!(limit / TEST_RATE > 12 * 3_600);
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
        let mut capture = capture_holding(&root, "a.wav", &[]);
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
        let mut capture = capture_holding(&root, "a.wav", &[]);
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
        let mut capture = capture_holding(&root, "a.wav", &tone(TEST_RATE, 2));
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
        assert!(std::fs::metadata(root.path().join("1.wav")).unwrap().len() > 44);
    }
}
