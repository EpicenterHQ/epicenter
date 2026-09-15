//! CPAL recorder built around a two-thread pipeline.
//!
//! ```text
//! cpal callback thread            writer worker thread
//! ┌──────────────────────┐  chan  ┌──────────────────────┐
//! │ build_input_stream   │ ─────▶ │ run_capture          │
//! │  - downmix to mono   │ bound  │  - hound WavWriter   │
//! │  - convert to PCM16  │   ed   │  - pad short clips   │
//! │  - try_send, or drop │        │  - emit mic level    │
//! └──────────────────────┘        └──────────────────────┘
//! ```
//!
//! The cpal callback never blocks and never touches a file: it downmixes to
//! mono, converts to PCM16, and hands the chunk to a **bounded** channel with
//! `try_send`. A full channel drops the chunk, which is the only outcome that
//! keeps a stalled disk from stalling the audio thread.
//!
//! The worker writes those chunks straight into a staged WAV as they arrive, so
//! memory is flat in the recording's length rather than proportional to it. An
//! hour-long meeting costs the same resident audio as a four-second dictation:
//! one bounded queue and one `BufWriter`. That is the whole reason this path
//! exists, and it is why there is no separate long-form mode for an application
//! to select.
//!
//! # The staged file is at the device's rate, and that is private
//!
//! Capture writes mono PCM16 at whatever rate the microphone actually opened.
//! Nothing resamples during capture, because a streaming resampler in the write
//! path buys nothing: transcription already decodes arbitrary rates down to
//! 16 kHz, and cloud upload already resamples to 48 kHz for Opus. So the rate a
//! blob happens to be at is mechanism, not contract; no caller chooses it and no
//! caller reads it.
//!
//! # One recorder, owned by the window that started it
//!
//! There is exactly one recorder for the whole host, and at most one
//! recording in flight. A recording is addressed by the blob id the host
//! minted for it and is owned by the window label that started it. Every
//! lifecycle method takes both, so an application can only ever stop or
//! cancel the recording it actually started: a competing `start` is refused
//! with [`RecorderError::Busy`] rather than silently displacing the live one.
//!
//! # An ended recording is still the owner's to claim
//!
//! Capture can stop without anyone asking: the microphone is unplugged, a
//! permission is withdrawn, the stream dies. That releases the *device*, not the
//! *recording*. [`Recorder::end_capture`] marks the recording ended, drops the
//! cpal stream, and leaves everything else exactly where it was: the slot stays
//! occupied, the staged file stays on disk, and [`Recorder::current`] keeps
//! answering with the same recording plus the reason its capture ended.
//!
//! That is the whole interruption design. There is no pending-interruption
//! inbox, no acknowledgement, no restore call, and no second channel that pushes
//! audio at the owner. `stop` remains the one path that finishes a file and
//! `cancel` remains the one path that deletes staging, whether or not capture is
//! still running when they are called. A competing `start` stays [`Busy`] until
//! the owner resolves it, or until the owning window is destroyed.
//!
//! [`Busy`]: RecorderError::Busy
//!
//! The label identifies a *window*, not an application: navigation across
//! `/apps/*` on the one loopback origin is permitted, so a window may change
//! which app it is showing. Under ADR-0179's full-trust model that is enough,
//! because ownership here exists for resource correctness, not isolation.
//! Labels are assigned by Rust (`BuiltInApp::id`, `app_window_label`) and cannot
//! be supplied by the frontend, which is what makes them usable at all.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream};
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use log::{debug, error, info, warn};
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::BufWriter;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::blobs::StagedBlob;
use crate::recorder::ended::EndedReason;
use crate::recorder::error::RecorderError;

/// Recorder result type. Errors cross the IPC boundary as the internally
/// tagged `RecorderError` enum (`{ name, message }`) so the JS side switches
/// on `error.name` instead of matching message text.
pub type Result<T> = std::result::Result<T, RecorderError>;

/// The rate to ask a microphone for, when it can oblige. Local GGUF
/// transcription consumes 16 kHz mono, so a device that opens there produces a
/// staged file transcription can read without resampling at all. A device that
/// cannot is opened at its own rate and nothing is lost: the decode path
/// resamples whatever it finds.
const PREFERRED_CAPTURE_RATE: u32 = 16_000;

/// Bytes one PCM16 sample occupies in the staged file.
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
/// At 48 kHz mono PCM16 the ceiling is about 12.4 hours, well past any meeting
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

/// Event name for live mic levels, emitted to the window that owns the
/// recording so its meter can reflect mic activity. The JS side never sees the
/// PCM, so the level has to originate here.
///
/// The owner window is the only recipient. An application that draws the meter
/// somewhere else too (Whispering's recording overlay is a second webview)
/// forwards it from there, which is what its VAD recorder already does for its
/// own levels. The host does not name another application's windows.
const MIC_LEVEL_EVENT: &str = "mic-level";

/// Minimum gap between mic-level emits. ~20 Hz is smooth for a meter and keeps
/// the targeted Tauri event off the IPC hot path (per Tauri's guidance to
/// throttle high-frequency events). Levels between emits are averaged, not
/// dropped, so a brief loud transient still registers.
const MIC_LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(50);

/// Worker-thread command channel.
///
/// `Stop` asks for the staged bytes back and `Cancel` deletes them; both end the
/// worker. `EndCapture` ends neither: it tells the worker its capture is over so
/// it can release the microphone and wait, still holding the staged file, for
/// the owner to stop or cancel it.
#[derive(Debug)]
enum RecorderCmd {
    Stop(mpsc::Sender<Result<FinalizedRecording>>),
    Cancel,
    EndCapture,
}

/// The staged WAV one capture is writing into.
///
/// Owned entirely by the worker thread, which is what lets the writer stay
/// unsynchronized: nothing else can reach the file, so there is no lock between
/// the audio path and the bytes.
struct StagedCapture {
    staged: StagedBlob,
    /// `None` only after finalization, so the writer can be consumed by value
    /// without leaving a half-alive one behind.
    writer: Option<WavWriter<BufWriter<std::fs::File>>>,
    device_rate: u32,
    write_failed: bool,
}

impl StagedCapture {
    /// Open a staged WAV for a recording about to start.
    ///
    /// Mono PCM16 at the device's own rate. Mono because a dictation microphone
    /// is one voice and the transcriber downmixes anyway; PCM16 because it
    /// halves the file against f32 at a noise floor two orders of magnitude
    /// below anything a microphone produces.
    fn open(staged: StagedBlob, device_rate: u32) -> Result<Self> {
        match Self::open_writer(&staged, device_rate) {
            Ok(writer) => Ok(Self {
                staged,
                writer: Some(writer),
                device_rate,
                write_failed: false,
            }),
            // A staging directory nothing can write to is debris, not a
            // recording waiting to happen.
            Err(error) => {
                staged.discard();
                Err(error)
            }
        }
    }

    fn open_writer(
        staged: &StagedBlob,
        device_rate: u32,
    ) -> Result<WavWriter<BufWriter<std::fs::File>>> {
        let path = staged.data_path();
        // `create_new` states the invariant rather than assuming it: the staging
        // directory was made for this recording alone, moments ago.
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| {
                RecorderError::failed(format!("create staged capture {}: {error}", path.display()))
            })?;
        let spec = WavSpec {
            channels: 1,
            sample_rate: device_rate,
            bits_per_sample: 16,
            sample_format: WavSampleFormat::Int,
        };
        WavWriter::new(BufWriter::new(file), spec).map_err(|error| {
            RecorderError::failed(format!("open wav writer {}: {error}", path.display()))
        })
    }

    /// Append one callback's worth of mono PCM16.
    ///
    /// The worker buffers samples; only Stop finalizes the WAV header.
    fn write(&mut self, samples: &[i16]) -> Result<()> {
        let result = self.write_samples(samples);
        if result.is_err() {
            self.write_failed = true;
        }
        result
    }

    fn write_samples(&mut self, samples: &[i16]) -> Result<()> {
        let Some(writer) = self.writer.as_mut() else {
            return Err(RecorderError::failed(
                "the staged capture is already finalized",
            ));
        };
        if would_exceed_wav_limit(writer.len(), samples.len()) {
            return Err(RecorderError::failed(
                "the recording reached the longest audio a WAV file can describe",
            ));
        }
        for &sample in samples {
            writer
                .write_sample(sample)
                .map_err(|error| RecorderError::failed(format!("write staged capture: {error}")))?;
        }
        Ok(())
    }

    /// Pad a sub-second recording with silence to 1.25 seconds.
    ///
    /// A product behavior, not a format requirement: Whisper hallucinates
    /// sentences into near-silent clips shorter than about a second. Expressed
    /// in the device's rate because that is what the file is at; it used to be a
    /// flat 20 000 samples, which was the same 1.25 s back when every recording
    /// was resampled to 16 kHz before it was written.
    ///
    /// A recording that captured nothing is left empty. There is no speech to
    /// protect, and padding it would turn "we heard nothing" into 1.25 s of
    /// silence that looks like a real recording.
    fn pad_if_short(&mut self) -> Result<()> {
        // Straight from the writer's own count, so the padding decision can
        // never disagree with the file.
        let captured = self.writer.as_ref().map_or(0, |writer| writer.len());
        if captured == 0 || captured >= self.device_rate {
            return Ok(());
        }
        let target = self.device_rate + self.device_rate / 4;
        let padding = vec![0i16; (target - captured) as usize];
        self.write(&padding)
    }

    /// Finalize the WAV and hand the staged bytes back to be published.
    ///
    /// A failed finalize discards temporary output and reports no finished file.
    fn finish(mut self) -> Result<FinalizedRecording> {
        if self.write_failed {
            self.discard();
            return Err(RecorderError::failed(
                "capture storage failed; no finished file was produced",
            ));
        }
        match self.finalize_wav() {
            Ok(sample_count) => Ok(FinalizedRecording {
                staged: self.staged,
                // Exact duration of what was written: the file's own sample
                // count over the rate it was captured at. Bounded by the RIFF
                // ceiling the writer enforces, so it always fits in `u32`.
                duration_ms: (sample_count as f64 / self.device_rate as f64 * 1000.0).round()
                    as u32,
            }),
            Err(error) => {
                self.staged.discard();
                Err(error)
            }
        }
    }

    fn finalize_wav(&mut self) -> Result<u32> {
        self.pad_if_short()?;
        let Some(writer) = self.writer.take() else {
            return Err(RecorderError::failed(
                "the staged capture is already finalized",
            ));
        };
        // Read before `finalize` consumes the writer. This is the count hound
        // will stamp into the header, and it counts only samples the writer
        // accepted, so a capture that hit a write error reports its prefix.
        let sample_count = writer.len();
        // Checked, never left to `Drop`. hound patches the header on drop too,
        // but a drop cannot report that the patch failed, and an unreported
        // failure here is a silently truncated recording. A successful
        // `finalize` also flushes, so every counted byte is on disk by the time
        // this returns.
        writer
            .finalize()
            .map_err(|error| RecorderError::failed(format!("finalize staged capture: {error}")))?;
        Ok(sample_count)
    }

    /// Delete the staged bytes without finalizing them.
    ///
    /// The writer is dropped first so its file handle is closed before the
    /// directory goes, which Windows requires and every platform prefers.
    fn discard(self) {
        drop(self.writer);
        self.staged.discard();
    }
}

/// A finalized staged WAV, on its way to becoming a blob.
///
/// The capture behind it is closed: its microphone is released, its worker has
/// exited, and its bytes are complete on disk. Only publication is left, which
/// is why this can safely cross out of the recorder lock.
#[derive(Debug)]
pub struct FinalizedRecording {
    pub(super) staged: StagedBlob,
    pub(super) duration_ms: u32,
}

impl FinalizedRecording {
    /// Publish the staged bytes as the blob at their id.
    ///
    /// Deliberately not done under the recorder lock. This is the fsync ladder,
    /// the slowest step in the whole lifecycle, and by the time it runs the
    /// recording is finished and out of the slot: nothing another window does
    /// can collide with it, because the next recording gets a different id.
    pub fn publish(self) -> Result<RecordedAudio> {
        // The recording command reports a u32 byte length. Refuse an oversized
        // WAV before publication; shared blob storage itself has no format cap.
        let byte_length = match std::fs::metadata(self.staged.data_path())
            .map_err(|error| RecorderError::failed(format!("stat finalized WAV: {error}")))
            .and_then(|metadata| {
                u32::try_from(metadata.len())
                    .map_err(|_| RecorderError::failed("finalized WAV exceeds the RIFF size limit"))
            }) {
            Ok(size) => size,
            Err(error) => {
                self.staged.discard();
                return Err(error);
            }
        };
        crate::timing::measure("stop.publish", || self.staged.publish("audio/wav"))?;
        Ok(RecordedAudio {
            duration_ms: self.duration_ms,
            byte_length,
        })
    }
}

/// What a stopped recording committed: the two facts only the host can state
/// exactly, once the blob is on disk.
pub struct RecordedAudio {
    pub duration_ms: u32,
    pub byte_length: u32,
}

/// The one recording the recorder holds: its identity, its owner, and the
/// worker carrying it.
///
/// "Held" rather than "in flight", because capture may already be over. The
/// recording keeps this slot either way until its owner resolves it.
struct HeldRecording {
    /// The blob id the host minted at `start`. It names the blob this
    /// recording will become; `cancel` burns it without ever writing one.
    audio_blob_id: String,
    /// Label of the window that called `start`. Stop is restricted to it.
    owner_label: String,
    /// Which microphone this recording opened, for the owning document's UI.
    device: DeviceAcquisition,
    /// `None` while capture is running. `Some` once capture ended on its own,
    /// which is a fact about this recording and not a separate state machine:
    /// everything else about it is unchanged.
    ended_reason: Option<EndedReason>,
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
    pub(super) sessions: super::sessions::Sessions,
}

/// The document's live capture identity, opened microphone, and terminal event.
/// `current` reconciles a missed event while that same document remains alive.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostRecording {
    pub audio_blob_id: String,
    pub device: DeviceAcquisition,
    /// `None` while capture is running. `Some` means capture is over and this
    /// recording is waiting to be stopped (finishing its temporary file) or
    /// cancelled (discarding it).
    pub ended_reason: Option<EndedReason>,
}

impl Recorder {
    pub fn new() -> Self {
        Self::default()
    }

    /// List available recording devices by name.
    pub fn enumerate_devices(&self) -> Result<Vec<String>> {
        let host = cpal::default_host();
        let devices = host
            .input_devices()
            .map_err(|e| RecorderError::classify_cpal("Failed to get input devices", e))?
            // A device names itself via `description()`. Skip any that can't
            // describe themselves rather than letting `Display`/`to_string()`
            // panic on the underlying description failure.
            .filter_map(|device| device.description().ok().map(|d| d.name().to_string()))
            .collect();

        Ok(devices)
    }

    /// Open the input stream and begin capturing, in one step.
    ///
    /// Returns [`RecorderError::Busy`] when the slot is occupied, so a competing
    /// start is refused instead of displacing a recording some other window is
    /// relying on. A recording whose capture already ended still occupies it:
    /// its audio is claimable until its owner stops or cancels it, and quietly
    /// throwing that away to make room would be exactly the loss this design
    /// exists to prevent.
    ///
    /// The device is resolved here rather than by the caller. A caller that
    /// picked a device from a stale list would otherwise have to enumerate,
    /// compare, and choose a substitute before it could start, duplicating a
    /// decision the host has to be able to make anyway. The returned
    /// [`DeviceAcquisition`] names the device actually opened, so an
    /// application can tell the person what it fell back to and persist it.
    ///
    /// The cpal stream is built inside the worker (macOS requires the stream and
    /// the run loop driving it to share a thread) and its outcome is reported
    /// back over `ready_rx`, so a stream that fails to open surfaces as the real
    /// classified error rather than as a dropped channel.
    pub fn start(
        &mut self,
        requested_device: Option<&str>,
        audio_blob_id: String,
        owner_label: String,
        app_handle: AppHandle,
    ) -> Result<HostRecording> {
        self.require_free_slot()?;

        let host = cpal::default_host();
        let (device, acquisition) = resolve_device(&host, requested_device)?;
        let config = get_optimal_config(&device)?;
        let sample_format = config.sample_format();
        let device_rate = config.sample_rate();
        let device_channels = config.channels();

        let stream_config = cpal::StreamConfig {
            channels: device_channels,
            sample_rate: device_rate,
            buffer_size: cpal::BufferSize::Default,
        };

        // Staging is opened before the microphone, so a recording that cannot be
        // written fails now rather than after an hour of captured speech.
        let capture = StagedCapture::open(
            StagedBlob::disposable(&app_handle, &audio_blob_id)?,
            device_rate,
        )?;

        let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<i16>>(CAPTURE_QUEUE_CHUNKS);
        let (cmd_tx, cmd_rx) = mpsc::channel::<RecorderCmd>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
        let dropped_chunks = Arc::new(AtomicU32::new(0));
        let sink = ChunkSink {
            sample_tx,
            dropped_chunks: Arc::clone(&dropped_chunks),
        };
        let on_error = capture_error_handler(app_handle.clone(), audio_blob_id.clone());
        let meter_label = owner_label.clone();
        let worker_blob_id = audio_blob_id.clone();

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
                    // Nothing was ever captured, so the staging this opened is
                    // debris rather than a recording anyone could claim.
                    capture.discard();
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
                    audio_blob_id: &worker_blob_id,
                    owner_label: &meter_label,
                    dropped_chunks: &dropped_chunks,
                    app_handle,
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
            "Recording started: id={audio_blob_id}, owner={owner_label}, device={}, {device_rate} Hz, {device_channels} channels",
            acquisition.device_id(),
        );
        self.active = Some(HeldRecording {
            audio_blob_id: audio_blob_id.clone(),
            owner_label,
            device: acquisition.clone(),
            ended_reason: None,
            cmd_tx,
            worker,
        });
        Ok(HostRecording {
            audio_blob_id,
            device: acquisition,
            ended_reason: None,
        })
    }

    /// Mark the recording named by `audio_blob_id` as ended because its capture
    /// stopped on its own, returning the window that owns it so the host can
    /// tell it.
    ///
    /// This ends the *capture*, not the recording. The worker releases the
    /// microphone and keeps everything it captured, the slot stays occupied, and
    /// [`Recorder::current`] keeps answering with the same recording. Only the
    /// owner decides what happens to the audio, through `stop` or `cancel`.
    ///
    /// Matched on the blob id, not just the owner: a stream error can arrive
    /// after the owner already started a second recording, and killing that one
    /// because its predecessor's hardware failed would be its own bug. A
    /// non-matching or already-ended id makes this a no-op, which is what makes
    /// it idempotent when cpal reports the same failure more than once.
    pub fn end_capture(&mut self, audio_blob_id: &str, reason: EndedReason) -> Option<String> {
        let active = self.active.as_mut()?;
        if active.audio_blob_id != audio_blob_id || active.ended_reason.is_some() {
            return None;
        }
        active.ended_reason = Some(reason);
        // Sent, never joined. This runs under the recorder lock, and the worker
        // it is signalling may be mid-handoff with a `stop` that is waiting on
        // that same lock; joining here would deadlock the pair. The channel is
        // unbounded, so the send itself cannot block. A send failure means the
        // worker is already gone, which is the same outcome by another route.
        let _ = active.cmd_tx.send(RecorderCmd::EndCapture);
        Some(active.owner_label.clone())
    }

    /// Stop the recording named by `audio_blob_id` and consume its mono 16 kHz
    /// PCM. Restricted to the window that started it: only the owner may turn a
    /// recording into a blob it can read.
    ///
    /// Works the same whether capture is still running or already ended. That is
    /// the point of holding an ended recording: `stop` is the one publication
    /// path, so the audio captured before a microphone died is reached by the
    /// same call as the audio captured before the person let go of the button.
    pub fn stop(&mut self, audio_blob_id: &str, caller_label: &str) -> Result<FinalizedRecording> {
        self.require_owned(audio_blob_id, caller_label)?;
        // Taken before the round trip: whether the worker answers or dies, this
        // recording is over and the slot must be free for the next start.
        //
        // The slot is nonetheless unavailable for the whole round trip, because
        // `&mut self` here comes from the one recorder mutex and nothing else can
        // acquire it until this returns. That is load-bearing: the worker is
        // still holding an open cpal stream until it answers, and a `start` that
        // slipped in beforehand would open a second microphone against a
        // recorder that is supposed to have exactly one.
        let active = self.active.take().expect("ownership was just verified");

        let (reply_tx, reply_rx) = mpsc::channel();
        let finalized = match active.cmd_tx.send(RecorderCmd::Stop(reply_tx)) {
            Ok(()) => reply_rx
                .recv()
                .map_err(|e| {
                    RecorderError::failed(format!(
                        "Worker dropped the stop reply for {audio_blob_id}: {e}"
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
        finalized
    }

    /// Cancel the recording named by `audio_blob_id`, discarding its audio.
    ///
    /// Restricted to the owner window, for the same reason `stop` is: a
    /// recording another window is relying on must not vanish under it. The
    /// host cancels through [`Recorder::cancel_owned_by`] instead, which is not
    /// reachable over IPC.
    pub fn cancel(&mut self, audio_blob_id: &str, caller_label: &str) -> Result<()> {
        self.require_owned(audio_blob_id, caller_label)?;
        let active = self.active.take().expect("ownership was just verified");
        discard(active);
        Ok(())
    }

    /// Cancel the in-flight recording if `owner_label` owns it, returning the
    /// burnt blob id. The host's own path, used when the owner window is
    /// destroyed: the recording it owns can no longer be stopped by anyone, so
    /// holding the single recorder slot for it would wedge every other window.
    pub fn cancel_owned_by(&mut self, owner_label: &str) -> Option<String> {
        let active = self
            .active
            .take_if(|active| active.owner_label == owner_label)?;
        let audio_blob_id = active.audio_blob_id.clone();
        discard(active);
        Some(audio_blob_id)
    }

    /// The recording `caller_label` owns, if any.
    ///
    /// A pure read: it never resolves, repairs, or consumes anything, so calling
    /// it twice answers twice with the same recording. Scoped to the caller
    /// rather than global, so a window learns about its own recording and
    /// nothing else.
    ///
    /// The IPC boundary additionally verifies the document's session. Reload
    /// retires that document; this read cannot adopt its abandoned capture.
    pub fn current(&self, caller_label: &str) -> Option<HostRecording> {
        self.active
            .as_ref()
            .filter(|active| active.owner_label == caller_label)
            .map(|active| HostRecording {
                audio_blob_id: active.audio_blob_id.clone(),
                device: active.device.clone(),
                ended_reason: active.ended_reason,
            })
    }

    /// Whether a microphone is open right now, for the host's tray indicator.
    ///
    /// Deliberately not "is the slot occupied". A recording whose capture died
    /// still holds the slot, but nothing is being captured, and a tray that kept
    /// claiming otherwise would be lying about the microphone.
    pub fn is_capturing(&self) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.ended_reason.is_none())
    }

    pub fn holds(&self, id: &str) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.audio_blob_id == id)
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
            active.audio_blob_id, active.owner_label
        )))
    }

    /// The one ownership rule, in one place: the named recording must be the
    /// one held and must belong to the calling window.
    ///
    /// Both failures collapse to `NotRecording`. The caller cannot act
    /// differently on "no such recording" versus "not yours" (both mean "this
    /// window has nothing to stop"), and the distinguishing detail still
    /// travels in `message` for diagnostics.
    fn require_owned(&self, audio_blob_id: &str, caller_label: &str) -> Result<()> {
        let Some(active) = &self.active else {
            return Err(RecorderError::not_recording(format!(
                "no recording is held; '{audio_blob_id}' has already been stopped or cancelled"
            )));
        };
        if active.audio_blob_id != audio_blob_id {
            return Err(RecorderError::not_recording(format!(
                "the in-flight recording is not '{audio_blob_id}'"
            )));
        }
        if active.owner_label != caller_label {
            return Err(RecorderError::not_recording(format!(
                "recording '{audio_blob_id}' is owned by window '{}', not '{caller_label}'",
                active.owner_label
            )));
        }
        Ok(())
    }
}

/// End a recording without producing anything: tell the worker to delete its
/// staged bytes, then join it so the cpal stream is released before returning.
fn discard(active: HeldRecording) {
    // A send failure means the worker is already gone, which is the same
    // outcome by another route, so it is not an error to report.
    let _ = active.cmd_tx.send(RecorderCmd::Cancel);
    let _ = active.worker.join();
    debug!("Recording {} cancelled", active.audio_blob_id);
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if let Some(active) = self.active.take() {
            discard(active);
        }
        self.discard_all_finished();
    }
}

/// Who a capture belongs to, and how to reach them.
///
/// One value rather than four parameters, because none of it is about audio:
/// it is the recording's identity and the two ways the worker speaks about it,
/// a meter to the owner window and a failure report to the host.
struct CaptureContext<'a> {
    audio_blob_id: &'a str,
    owner_label: &'a str,
    dropped_chunks: &'a AtomicU32,
    app_handle: AppHandle,
}

/// What the capture phase left behind.
enum CaptureOutcome {
    /// The owner already resolved the recording: a `Stop` was answered from the
    /// staged file, or a `Cancel` deleted it. Nothing is left to wait for.
    Resolved,
    /// Capture ended with the recording still unclaimed. The staged file is
    /// intact and its owner may still stop or cancel it.
    Unclaimed(StagedCapture),
}

/// Capture phase. Writes mono PCM16 into the staged WAV as it arrives, emitting
/// a throttled RMS level to the owner window so its meter can reflect live mic
/// activity.
///
/// The staged capture is passed by value because whichever way this ends, it
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
    mut capture: StagedCapture,
    stream: S,
    context: CaptureContext<'_>,
) -> CaptureOutcome {
    use std::sync::mpsc::RecvTimeoutError;

    let CaptureContext {
        audio_blob_id,
        owner_label,
        dropped_chunks,
        app_handle,
    } = context;

    // Mic-level metering accumulators, averaged and flushed on an interval.
    let mut level_sumsq = 0f64;
    let mut level_count = 0usize;
    let mut last_level_emit = Instant::now();
    let mut last_drop_report = Instant::now();

    loop {
        // Command channel has priority. Stop should respond fast even
        // when audio frames are arriving back-to-back.
        match cmd_rx.try_recv() {
            Ok(RecorderCmd::Stop(reply)) => {
                close_capture_and_drain(stream, &mut capture, &sample_rx);
                report_dropped_chunks(dropped_chunks, audio_blob_id);
                let _ = reply.send(capture.finish());
                return CaptureOutcome::Resolved;
            }
            Ok(RecorderCmd::Cancel) => {
                drop(stream);
                capture.discard();
                return CaptureOutcome::Resolved;
            }
            // Capture is over but the recording is not: hand the staged file up
            // so it can wait for the owner to stop or cancel it.
            Ok(RecorderCmd::EndCapture) => {
                close_capture_and_drain(stream, &mut capture, &sample_rx);
                report_dropped_chunks(dropped_chunks, audio_blob_id);
                return CaptureOutcome::Unclaimed(capture);
            }
            // The command sender is gone without a stop or a cancel, so nobody
            // is left to claim this recording.
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
            report_dropped_chunks(dropped_chunks, audio_blob_id);
            last_drop_report = Instant::now();
        }

        match sample_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(samples) => {
                for &sample in &samples {
                    let normalized = sample as f64 / 32_768.0;
                    level_sumsq += normalized * normalized;
                }
                level_count += samples.len();

                if let Err(error) = capture.write(&samples) {
                    // A write that fails is terminal: the disk is full, the
                    // volume vanished, or the recording hit the size a WAV can
                    // describe. None of those get better by trying again, so the
                    // capture ends here and the recording keeps whatever prefix
                    // reached the file.
                    error!("Recording {audio_blob_id} could not write its capture: {error}");
                    // Closed without draining: the writes that would consume the
                    // queue are the writes that are failing.
                    drop(stream);
                    let app = app_handle.clone();
                    let id = audio_blob_id.to_string();
                    // On its own thread for the same reason the cpal error
                    // callback uses one: this locks the recorder, and a `stop`
                    // may be holding that lock while waiting on this very
                    // worker.
                    thread::spawn(move || {
                        crate::recorder::commands::end_recording_capture(
                            &app,
                            &id,
                            EndedReason::StorageFailed,
                        );
                    });
                    return CaptureOutcome::Unclaimed(capture);
                }

                if last_level_emit.elapsed() >= MIC_LEVEL_EMIT_INTERVAL && level_count > 0 {
                    let rms = (level_sumsq / level_count as f64).sqrt() as f32;
                    // A targeted emit, never a broadcast: a level is about one
                    // window's recording, and every other window is entitled
                    // not to hear it. Not an error if the owner window is
                    // hidden or gone, and never fatal.
                    let _ = app_handle.emit_to(
                        owner_label,
                        MIC_LEVEL_EVENT,
                        serde_json::json!({ "audioBlobId": audio_blob_id, "level": rms }),
                    );
                    level_sumsq = 0.0;
                    level_count = 0;
                    last_level_emit = Instant::now();
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            // The sample sender lives inside the cpal stream, which this
            // worker's caller owns and drops only after this returns, so this is
            // not reachable today. Park rather than discard if it ever becomes
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
/// publishing the prefix that reached it beats failing the whole recording.
fn close_capture_and_drain<S>(
    stream: S,
    capture: &mut StagedCapture,
    sample_rx: &mpsc::Receiver<Vec<i16>>,
) {
    drop(stream);
    let deadline = Instant::now() + CAPTURE_CLOSE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match sample_rx.recv_timeout(remaining) {
            Ok(samples) => {
                if let Err(error) = capture.write(&samples) {
                    warn!("Could not write the last queued audio, publishing without it: {error}");
                    return;
                }
            }
            // Every sender is gone: the queue is empty and stays empty.
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                warn!(
                    "Capture stream did not finish closing within {CAPTURE_CLOSE_TIMEOUT:?}; publishing what reached the writer"
                );
                return;
            }
        }
    }
}

/// Report and reset the chunks the callback had to drop, if any.
///
/// Swapped rather than read, so no count is lost between reports.
fn report_dropped_chunks(dropped_chunks: &AtomicU32, audio_blob_id: &str) {
    let dropped = dropped_chunks.swap(0, Ordering::Relaxed);
    if dropped > 0 {
        warn!(
            "Recording {audio_blob_id} dropped {dropped} audio chunks: the staged writer is not keeping up with the microphone"
        );
    }
}

/// Wait for the owner to resolve a recording whose capture is over.
///
/// The staged file stays exactly as capture left it, and this thread is the only
/// thing that can reach it. That is what makes "an ended recording is still the
/// owner's to claim" true without a catch-up queue or a restore call: the same
/// `Stop` a live recording answers is answered here, from the same file.
fn await_resolution(capture: StagedCapture, cmd_rx: &mpsc::Receiver<RecorderCmd>) {
    loop {
        match cmd_rx.recv() {
            Err(_) => {
                capture.discard();
                return;
            }
            Ok(RecorderCmd::Stop(reply)) => {
                let _ = reply.send(capture.finish());
                return;
            }
            // Cancel deletes the staged bytes. A disconnected channel means the
            // recorder itself is gone, which has the same effect and nobody left
            // to tell.
            Ok(RecorderCmd::Cancel) => {
                capture.discard();
                return;
            }
            // `end_capture` refuses to signal an already-ended recording, so
            // this cannot arrive twice; ignoring it keeps that a fact about the
            // recorder rather than something this loop has to enforce.
            Ok(RecorderCmd::EndCapture) => {}
        }
    }
}

/// Which microphone a recording actually opened, and whether that was the one
/// asked for.
///
/// Serialized to match `DeviceAcquisitionOutcome` in `@epicenter/recorder`,
/// which the browser recorder already produces, so both platforms report device
/// acquisition in one shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DeviceAcquisition {
    /// The requested device was found and opened.
    Success { device_id: String },
    /// A different device was opened. `device_id` is what actually recorded, so
    /// an application can say which microphone it is using and persist it.
    Fallback {
        reason: FallbackReason,
        device_id: String,
    },
}

impl DeviceAcquisition {
    pub fn device_id(&self) -> &str {
        match self {
            Self::Success { device_id } | Self::Fallback { device_id, .. } => device_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackReason {
    /// No device was requested, so the system default was used.
    NoDeviceSelected,
    /// The requested device is not present, so the system default was used.
    PreferredDeviceUnavailable,
}

/// Resolve the microphone to record from, falling back to the system default.
///
/// Falling back rather than failing is deliberate and preexisting: a saved
/// device that is merely unplugged should not turn the record button into an
/// error, and the application reports the substitution and persists it. What
/// changed when this moved into Rust is only the fallback *target*. The
/// TypeScript version fell back to whichever device cpal happened to enumerate
/// first; this uses the system default, which is the device the person has
/// actually chosen at the OS level. Both are silent substitutions reported the
/// same way, so the user-visible contract is unchanged.
fn resolve_device(
    host: &cpal::Host,
    requested: Option<&str>,
) -> Result<(Device, DeviceAcquisition)> {
    let default_device = || {
        host.default_input_device().ok_or_else(|| {
            RecorderError::no_input_device("No microphone is available to record from")
        })
    };

    let Some(requested) = requested else {
        let device = default_device()?;
        let device_id = device_name(&device)?;
        return Ok((
            device,
            DeviceAcquisition::Fallback {
                reason: FallbackReason::NoDeviceSelected,
                device_id,
            },
        ));
    };

    let devices: Vec<_> = host
        .input_devices()
        .map_err(|e| RecorderError::classify_cpal("Failed to list input devices", e))?
        .collect();
    for device in devices {
        if device.description().is_ok_and(|d| d.name() == requested) {
            return Ok((
                device,
                DeviceAcquisition::Success {
                    device_id: requested.to_string(),
                },
            ));
        }
    }

    let device = default_device()?;
    let device_id = device_name(&device)?;
    Ok((
        device,
        DeviceAcquisition::Fallback {
            reason: FallbackReason::PreferredDeviceUnavailable,
            device_id,
        },
    ))
}

/// The name a device calls itself, which is also the id every other layer uses
/// to refer to it. A device that cannot describe itself cannot be persisted as
/// a choice, so this refuses rather than inventing a placeholder.
fn device_name(device: &Device) -> Result<String> {
    device
        .description()
        .map(|description| description.name().to_string())
        .map_err(|e| RecorderError::classify_cpal("Failed to read the input device name", e))
}

/// Get the best supported configuration for voice recording.
///
/// Prefers mono at the host's 16 kHz target, falls back to stereo at that rate,
/// then to the closest supported rate.
fn get_optimal_config(device: &Device) -> Result<cpal::SupportedStreamConfig> {
    let target_sample_rate = PREFERRED_CAPTURE_RATE;

    // A device that yields no input configs is unusable as an input, whether the
    // query *errors* or returns *empty*: both mean "this mic can't tell us how to
    // record from it," so both classify as NoInputDevice ("connect a microphone")
    // rather than a generic Failed the user can't act on.
    //
    // A query error here means the device can't describe how to record from it,
    // which for the user is indistinguishable from "no mic," so collapse it to
    // NoInputDevice. cpal 0.18 types a true denial as PermissionDenied and often
    // routes a vanished-mic config query to a generic kind (macOS sends the
    // OSStatus failure to BackendError), so only a Failed is remapped; a
    // PermissionDenied passes through untouched.
    let configs: Vec<_> = device
        .supported_input_configs()
        .map_err(
            |e| match RecorderError::classify_cpal("Failed to query input configs", e) {
                RecorderError::Failed { message } => RecorderError::NoInputDevice { message },
                classified => classified,
            },
        )?
        .collect();
    if configs.is_empty() {
        return Err(RecorderError::no_input_device(
            "No supported input configurations",
        ));
    }

    let supported_formats = [SampleFormat::F32, SampleFormat::I16, SampleFormat::U16];
    let compatible_configs: Vec<_> = configs
        .iter()
        .filter(|config| supported_formats.contains(&config.sample_format()))
        .collect();
    if compatible_configs.is_empty() {
        return Err(RecorderError::failed(
            "No configurations with supported sample formats (F32, I16, U16)",
        ));
    }

    // Mono at target rate if possible.
    for config in &compatible_configs {
        if config.channels() == 1 {
            let (min, max) = (config.min_sample_rate(), config.max_sample_rate());
            if min <= target_sample_rate && max >= target_sample_rate {
                return Ok(config.with_sample_rate(target_sample_rate));
            }
        }
    }

    // Any channel count at target rate.
    for config in &compatible_configs {
        let (min, max) = (config.min_sample_rate(), config.max_sample_rate());
        if min <= target_sample_rate && max >= target_sample_rate {
            return Ok(config.with_sample_rate(target_sample_rate));
        }
    }

    // Closest-rate fallback, preferring mono.
    let mut best_config: Option<cpal::SupportedStreamConfig> = None;
    let mut best_diff = u32::MAX;
    for config in &compatible_configs {
        if config.channels() != 1 {
            continue;
        }
        let (min, max) = (config.min_sample_rate(), config.max_sample_rate());
        let closest = if target_sample_rate < min {
            min
        } else if target_sample_rate > max {
            max
        } else {
            target_sample_rate
        };
        let diff = (closest as i32 - target_sample_rate as i32).unsigned_abs();
        if diff < best_diff {
            best_diff = diff;
            best_config = Some(config.with_sample_rate(closest));
        }
    }

    // No mono config matched a rate window above; fall back to the first
    // compatible config. `compatible_configs` is non-empty here (guarded
    // earlier), so a config always exists: there is no "no suitable
    // configuration" failure left to model.
    Ok(best_config.unwrap_or_else(|| {
        let config = compatible_configs[0];
        let (min, max) = (config.min_sample_rate(), config.max_sample_rate());
        let rate = if min <= target_sample_rate && max >= target_sample_rate {
            target_sample_rate
        } else {
            min
        };
        config.with_sample_rate(rate)
    }))
}

/// Where a cpal callback puts a chunk: into the writer's queue, or on the floor.
///
/// One value rather than two parameters, because the counter is meaningless
/// apart from the channel whose refusals it counts.
struct ChunkSink {
    sample_tx: mpsc::SyncSender<Vec<i16>>,
    dropped_chunks: Arc<AtomicU32>,
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
/// Only a terminal error: [`ended::classify`] returns `None` for the conditions
/// cpal documents as survivable, so a routine audio-route change (plugging in
/// headphones) no longer looks like a dead microphone.
///
/// [`ended::classify`]: crate::recorder::ended::classify
fn capture_error_handler(
    app: AppHandle,
    audio_blob_id: String,
) -> impl Fn(cpal::Error) + Send + 'static {
    move |error: cpal::Error| {
        let Some(reason) = crate::recorder::ended::classify(&error) else {
            debug!("Audio stream reported a survivable condition, continuing: {error}");
            return;
        };
        error!("Audio stream ended the capture: {error}");
        let app = app.clone();
        let audio_blob_id = audio_blob_id.clone();
        // On its own thread because this locks the recorder, which may not
        // happen on an audio callback. It fires at most once per stream death
        // and never on the sample path.
        thread::spawn(move || {
            crate::recorder::commands::end_recording_capture(&app, &audio_blob_id, reason);
        });
    }
}

/// Build the cpal input stream. The callback's only job is to downmix to mono
/// PCM16 and hand the chunk off; the worker owns the file and everything else.
fn build_input_stream(
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
        SampleFormat::U16 => device
            .build_input_stream(
                config,
                move |data: &[u16], _: &_| sink.hand_off(downmix_u16(data, n_channels)),
                on_error,
                None,
            )
            .map_err(|e| RecorderError::classify_cpal("Failed to build U16 stream", e))?,
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
/// because two of the three formats are already integers: routing them through
/// f32 and back would add a rounding step to a conversion that has none.
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

fn downmix_u16(interleaved: &[u16], channels: usize) -> Vec<i16> {
    // u16 PCM is offset binary: 32768 is silence, so the conversion to signed
    // PCM16 is exactly that subtraction.
    let to_pcm16 = |sample: u16| sample as i32 - 32_768;
    if channels <= 1 {
        return interleaved.iter().map(|&s| to_pcm16(s) as i16).collect();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| (frame.iter().map(|&s| to_pcm16(s)).sum::<i32>() / channels as i32) as i16)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::decode_to_pcm16k_mono;
    use tempfile::TempDir;

    /// The rate these tests capture at, chosen to be the common device rate
    /// rather than the preferred one, so nothing accidentally passes because
    /// capture and transcription happen to agree.
    const TEST_RATE: u32 = 48_000;

    #[tokio::test]
    #[ignore = "opens the physical default microphone for two seconds; run only for explicit native acceptance"]
    async fn physical_microphone_finishes_and_reopens_without_a_webview_audio_buffer() {
        let permission = crate::command::get_microphone_permission().await;
        let devices = Recorder::new().enumerate_devices().unwrap();
        eprintln!("NATIVE_CAPTURE_ENV permission={permission:?}, inputs={devices:?}");
        assert!(
            matches!(
                permission,
                crate::command::MicrophonePermission::Granted
                    | crate::command::MicrophonePermission::Unknown
            ),
            "physical capture requires microphone authorization for this executable"
        );
        let root = staging_root();
        for id in ["blob_aaaaaaaaaaaaaaaaaaaaa", "blob_bbbbbbbbbbbbbbbbbbbbb"] {
            let (device, acquisition) = resolve_device(&cpal::default_host(), None).unwrap();
            let config = get_optimal_config(&device).unwrap();
            let rate = config.sample_rate();
            let staged = StagedBlob::stage(root.path().into(), id).unwrap();
            let mut capture = StagedCapture::open(staged, rate).unwrap();
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
            let until = Instant::now() + Duration::from_secs(1);
            while Instant::now() < until {
                if let Ok(samples) = rx.recv_timeout(Duration::from_millis(20)) {
                    capture.write(&samples).unwrap();
                }
            }
            close_capture_and_drain(stream, &mut capture, &rx);
            let finished = capture.finish().unwrap();
            let bytes = std::fs::read(finished.staged.data_path()).unwrap();
            let samples = decode_to_pcm16k_mono(&bytes).unwrap();
            assert!(!samples.is_empty(), "physical input delivered no audio");
            assert_eq!(dropped.load(Ordering::Relaxed), 0);
            eprintln!("NATIVE_CAPTURE_RESULT device={}, rate={rate}, duration_ms={}, bytes={}, decoded_samples={}", acquisition.device_id(), finished.duration_ms, bytes.len(), samples.len());
            finished.staged.discard();
        }
    }

    #[test]
    fn a_real_capture_write_failure_cannot_be_finished_as_success() {
        let root = staging_root();
        let staged = StagedBlob::stage(root.path().into(), "blob_aaaaaaaaaaaaaaaaaaaaa").unwrap();
        std::fs::write(staged.data_path(), []).unwrap();
        let file = std::fs::File::open(staged.data_path()).unwrap();
        let writer = WavWriter::new(
            BufWriter::new(file),
            WavSpec {
                channels: 1,
                sample_rate: TEST_RATE,
                bits_per_sample: 16,
                sample_format: WavSampleFormat::Int,
            },
        )
        .unwrap();
        let mut capture = StagedCapture {
            staged,
            writer: Some(writer),
            device_rate: TEST_RATE,
            write_failed: false,
        };
        assert!(capture.write(&tone(TEST_RATE, 1)).is_err());
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let worker = thread::spawn(move || await_resolution(capture, &cmd_rx));
        let mut recorder = Recorder::new();
        recorder.register_session("owner", "document").unwrap();
        let id = "blob_aaaaaaaaaaaaaaaaaaaaa";
        recorder.active = Some(HeldRecording {
            audio_blob_id: id.into(),
            owner_label: "owner".into(),
            device: DeviceAcquisition::Success {
                device_id: "storage-failure-fixture".into(),
            },
            ended_reason: Some(EndedReason::StorageFailed),
            cmd_tx,
            worker,
        });
        assert!(matches!(
            recorder.stop_session("owner", "document", id),
            Err(RecorderError::CaptureLost { .. })
        ));
        assert!(recorder.current("owner").is_none());
        assert!(matches!(
            recorder.stop_session("owner", "document", id),
            Err(RecorderError::NotRecording { .. })
        ));
        recorder.require_free_slot().unwrap();
        assert_eq!(
            std::fs::read_dir(root.path().join(".staging/rust"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn an_oversized_recording_is_discarded_before_publication() {
        let root = staging_root();
        let id = "blob_aaaaaaaaaaaaaaaaaaaaa";
        let staged = StagedBlob::stage(root.path().into(), id).unwrap();
        let staged_path = staged.data_path();
        std::fs::File::create(&staged_path)
            .unwrap()
            .set_len(u64::from(u32::MAX) + 1)
            .unwrap();
        let recording = FinalizedRecording {
            staged,
            duration_ms: 1,
        };
        assert!(recording.publish().is_err());
        assert!(!root.path().join(id).exists());
        assert!(!staged_path.exists());
    }

    /// A blobs root that disappears with the test.
    fn staging_root() -> TempDir {
        tempfile::tempdir().expect("a temporary blobs root")
    }

    /// One second of a 440 Hz tone as mono PCM16, so a published blob has
    /// content a decoder can be checked against rather than just a length.
    fn tone(rate: u32, seconds: u32) -> Vec<i16> {
        (0..(rate * seconds))
            .map(|index| {
                let t = index as f32 / rate as f32;
                ((2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.5 * i16::MAX as f32) as i16
            })
            .collect()
    }

    /// A staged capture holding `samples`, ready to be finished.
    fn capture_holding(root: &TempDir, audio_blob_id: &str, samples: &[i16]) -> StagedCapture {
        let staged =
            StagedBlob::stage(root.path().to_path_buf(), audio_blob_id).expect("stage a blob");
        let mut capture = StagedCapture::open(staged, TEST_RATE).expect("open a staged capture");
        capture.write(samples).expect("write the capture");
        capture
    }

    /// Stand up a `HeldRecording` without opening a microphone.
    ///
    /// The lifecycle rules are pure state, so they are tested against real
    /// `Recorder` state rather than through cpal: a test that needs an input
    /// device cannot run in CI, and the rules being checked have nothing to do
    /// with audio.
    ///
    /// The stand-in worker is the real [`await_resolution`], parked on a real
    /// staged capture in a temporary blobs root. That is exactly the state a
    /// worker is in once its capture has ended, so `stop` here finalizes and
    /// publishes an actual WAV rather than a mock of one, and `discard`'s
    /// `Cancel`-then-join cannot hang: `await_resolution` returns on `Cancel`
    /// and on a dropped channel.
    fn recording_owned_by(
        recorder: &mut Recorder,
        root: &TempDir,
        audio_blob_id: &str,
        owner_label: &str,
    ) {
        let capture = capture_holding(root, audio_blob_id, &tone(TEST_RATE, 1));
        let (cmd_tx, cmd_rx) = mpsc::channel::<RecorderCmd>();
        let worker = thread::spawn(move || await_resolution(capture, &cmd_rx));
        recorder.active = Some(HeldRecording {
            audio_blob_id: audio_blob_id.to_string(),
            owner_label: owner_label.to_string(),
            device: DeviceAcquisition::Success {
                device_id: "Test Microphone".to_string(),
            },
            ended_reason: None,
            cmd_tx,
            worker,
        });
    }

    /// Stop a recording the way `stop_recording` does: close the capture under
    /// the recorder lock, then publish outside it.
    fn stop_and_publish(
        recorder: &mut Recorder,
        audio_blob_id: &str,
        caller_label: &str,
    ) -> Result<RecordedAudio> {
        recorder.stop(audio_blob_id, caller_label)?.publish()
    }

    fn error_name(error: &RecorderError) -> &'static str {
        match error {
            RecorderError::PermissionDenied { .. } => "PermissionDenied",
            RecorderError::NoInputDevice { .. } => "NoInputDevice",
            RecorderError::Busy { .. } => "Busy",
            RecorderError::NotRecording { .. } => "NotRecording",
            RecorderError::CaptureLost { .. } => "CaptureLost",
            RecorderError::Failed { .. } => "Failed",
        }
    }

    /// The blob id a `current` answer names, for the many assertions that only
    /// care which recording came back.
    fn current_id(recorder: &Recorder, caller_label: &str) -> Option<String> {
        recorder
            .current(caller_label)
            .map(|recording| recording.audio_blob_id)
    }

    #[test]
    fn a_fresh_recorder_is_idle_and_owns_nothing() {
        let recorder = Recorder::new();
        assert!(!recorder.is_capturing());
        assert!(recorder.current("whispering").is_none());
        recorder
            .require_free_slot()
            .expect("an idle recorder admits a start");
    }

    #[test]
    fn resolving_absence_fences_a_late_start_without_touching_a_successor_or_finished_file() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recorder.register_session("window", "document").unwrap();
        assert!(recorder
            .resolve_start("window", "document", "late")
            .unwrap()
            .is_none());
        assert!(recorder
            .prepare_start("window", "document", "late")
            .is_err());
        assert!(recorder
            .prepare_start("window", "document", "next")
            .unwrap()
            .is_none());
        let id = "blob_aaaaaaaaaaaaaaaaaaaaa";
        recording_owned_by(&mut recorder, &root, id, "window");
        recorder.remember_start("window", "document", "next", id);
        assert!(recorder
            .resolve_start("window", "document", "late")
            .unwrap()
            .is_none());
        assert_eq!(
            recorder
                .resolve_start("window", "document", "next")
                .unwrap()
                .unwrap()
                .audio_blob_id,
            id
        );
        recorder.stop_session("window", "document", id).unwrap();
        assert!(recorder
            .resolve_start("window", "document", "next")
            .unwrap()
            .is_none());
        assert!(recorder.stop_session("window", "document", id).is_ok());
        recorder.close_document("window");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn document_departure_discards_output_and_stale_commands_cannot_touch_successor() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        let old = "blob_aaaaaaaaaaaaaaaaaaaaa";
        let next = "blob_bbbbbbbbbbbbbbbbbbbbb";
        recorder.register_session("window", "document-1").unwrap();
        recording_owned_by(&mut recorder, &root, old, "window");
        recorder.remember_start("window", "document-1", "request-1", old);
        assert_eq!(
            recorder
                .prepare_start("window", "document-1", "request-1")
                .unwrap()
                .unwrap()
                .audio_blob_id,
            old
        );
        let stopped = recorder.stop_session("window", "document-1", old).unwrap();
        assert_eq!(stopped.byte_length, 96_044);
        assert_eq!(
            recorder
                .stop_session("window", "document-1", old)
                .unwrap()
                .byte_length,
            stopped.byte_length
        );
        assert!(recorder
            .prepare_start("window", "document-1", "request-2")
            .is_err());
        assert!(recorder
            .stop_session("intruder", "document-1", old)
            .is_err());
        recorder.close_document("window");
        assert!(recorder.register_session("window", "document-1").is_err());
        recorder.register_session("window", "document-2").unwrap();
        recording_owned_by(&mut recorder, &root, next, "window");
        recorder.close_session("window", "document-1");
        assert!(recorder
            .cancel_session("window", "document-1", next)
            .is_err());
        assert!(recorder.stop_session("window", "document-1", old).is_err());
        assert!(recorder.holds(next));
        recorder.close_document("window");
        assert!(!recorder.is_capturing());
        assert_eq!(
            std::fs::read_dir(root.path().join(".staging/rust"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn native_finished_publication_preserves_origin_after_lost_reply_and_retirement() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        let id = "blob_aaaaaaaaaaaaaaaaaaaaa";
        let key = "attachment.recordings.aaaaaaaaaaaaaaaaaaaaaaaa";
        let destination = crate::blobs::BlobDestination {
            app_id: "so.epicenter.notes".into(),
            replica: crate::blobs::LibraryReplica::Personal {
                account: crate::blobs::ReplicaAccount {
                    authority_id: "server-a".into(),
                    principal_id: "owner-a".into(),
                },
            },
        };
        recorder.register_session("window", "document").unwrap();
        recording_owned_by(&mut recorder, &root, id, "window");
        recorder.stop_session("window", "document", id).unwrap();
        assert!(recorder
            .publish_file("foreign", id, root.path(), &destination, key, Some(7))
            .is_err());
        let first = recorder
            .publish_file("window", id, root.path(), &destination, key, Some(7))
            .unwrap();
        assert_eq!(first.size, 96_044);
        let retry = recorder
            .publish_file("window", id, root.path(), &destination, key, Some(7))
            .unwrap();
        assert_eq!(first, retry);
        assert!(recorder
            .publish_file("window", id, root.path(), &destination, key, Some(8))
            .is_err());
        let published = crate::blobs::blobs_directory(root.path(), &destination)
            .unwrap()
            .join(key);
        let metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(published.join("metadata.json")).unwrap())
                .unwrap();
        assert_eq!(metadata["attachment"]["originGeneration"], 7);
        recorder.close_document("window");
        assert!(recorder
            .publish_file("window", id, root.path(), &destination, key, Some(7))
            .is_err());
        assert_eq!(
            std::fs::metadata(published.join("data")).unwrap().len(),
            u64::from(first.size)
        );
        let bytes = std::fs::read(published.join("data")).unwrap();
        assert!(!decode_to_pcm16k_mono(&bytes).unwrap().is_empty());
    }

    #[test]
    fn retirement_before_native_publication_refuses_without_creating_an_attachment() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        let id = "blob_aaaaaaaaaaaaaaaaaaaaa";
        let destination = crate::blobs::BlobDestination {
            app_id: "so.epicenter.notes".into(),
            replica: crate::blobs::LibraryReplica::Local {},
        };
        recorder.register_session("window", "document").unwrap();
        recording_owned_by(&mut recorder, &root, id, "window");
        recorder.stop_session("window", "document", id).unwrap();
        recorder.close_document("window");
        assert!(recorder
            .publish_file(
                "window",
                id,
                root.path(),
                &destination,
                "attachment.recordings.aaaaaaaaaaaaaaaaaaaaaaaa",
                None
            )
            .is_err());
        assert!(!crate::blobs::blobs_directory(root.path(), &destination)
            .unwrap()
            .exists());
    }

    #[test]
    fn current_is_scoped_to_the_owning_window() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );

        assert_eq!(
            current_id(&recorder, "app-notes").as_deref(),
            Some("blob_aaaaaaaaaaaaaaaaaaaaa"),
        );
        // A window that owns no recording learns nothing about one that exists.
        assert!(recorder.current("whispering").is_none());
    }

    /// `current` is a read, not a claim. Two calls answer twice, because a
    /// document that queries twice must find the same recording both times.
    #[test]
    fn reading_the_current_recording_never_consumes_it() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );
        recorder.end_capture(
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            EndedReason::DeviceDisconnected,
        );

        for _ in 0..3 {
            let recording = recorder.current("app-notes").expect("still held");
            assert_eq!(recording.audio_blob_id, "blob_aaaaaaaaaaaaaaaaaaaaa");
            assert_eq!(
                recording.ended_reason,
                Some(EndedReason::DeviceDisconnected)
            );
        }
    }

    #[test]
    fn a_non_owner_cannot_stop_or_cancel_and_the_recording_survives() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );

        let stop = recorder
            .stop("blob_aaaaaaaaaaaaaaaaaaaaa", "whispering")
            .expect_err("a non-owner must not stop another window's recording");
        assert_eq!(error_name(&stop), "NotRecording");

        let cancel = recorder
            .cancel("blob_aaaaaaaaaaaaaaaaaaaaa", "whispering")
            .expect_err("a non-owner must not cancel another window's recording");
        assert_eq!(error_name(&cancel), "NotRecording");

        // The refusals left the owner's recording completely untouched.
        assert!(recorder.is_capturing());
        assert_eq!(
            current_id(&recorder, "app-notes").as_deref(),
            Some("blob_aaaaaaaaaaaaaaaaaaaaa"),
        );
    }

    #[test]
    fn the_owner_cannot_stop_an_id_that_is_not_the_live_recording() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );

        let error = recorder
            .stop("blob_bbbbbbbbbbbbbbbbbbbbb", "app-notes")
            .expect_err("a stale id must not stop whatever happens to be live");
        assert_eq!(error_name(&error), "NotRecording");
        assert!(recorder.is_capturing());
    }

    #[test]
    fn the_owner_can_cancel_and_the_slot_is_released() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );

        recorder
            .cancel("blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes")
            .expect("the owner may cancel its own recording");

        assert!(!recorder.is_capturing());
        assert!(recorder.current("app-notes").is_none());
    }

    #[test]
    fn destroying_the_owner_window_cancels_only_its_own_recording() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );

        // A different window closing leaves the recording alone.
        assert_eq!(recorder.cancel_owned_by("whispering"), None);
        assert!(recorder.is_capturing());

        assert_eq!(
            recorder.cancel_owned_by("app-notes").as_deref(),
            Some("blob_aaaaaaaaaaaaaaaaaaaaa"),
        );
        assert!(!recorder.is_capturing());
    }

    /// A destroyed window can never claim its recording, so the host resolves it
    /// by cancelling, whether or not its capture already ended. This is the one
    /// route by which an ended recording releases the slot without its owner.
    #[test]
    fn destroying_the_owner_window_also_cancels_an_ended_recording() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );
        recorder.end_capture("blob_aaaaaaaaaaaaaaaaaaaaa", EndedReason::StreamFailed);

        assert_eq!(
            recorder.cancel_owned_by("app-notes").as_deref(),
            Some("blob_aaaaaaaaaaaaaaaaaaaaa"),
        );
        assert!(recorder.current("app-notes").is_none());
        recorder
            .require_free_slot()
            .expect("the slot is free once the owner is gone");
    }

    /// The heart of the interruption design: a dead stream ends the capture and
    /// nothing else. The audio is still there, the slot is still claimed, and the
    /// owner still decides what happens to it.
    #[test]
    fn a_dead_capture_keeps_the_recording_claimable_and_names_its_owner() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );

        assert_eq!(
            recorder
                .end_capture(
                    "blob_aaaaaaaaaaaaaaaaaaaaa",
                    EndedReason::DeviceDisconnected
                )
                .as_deref(),
            Some("app-notes"),
            "ending a capture must report the owner so the host can tell it"
        );

        // The microphone is closed, so the tray must stop claiming otherwise.
        assert!(!recorder.is_capturing());

        // Everything else is unchanged: same recording, same owner, now carrying
        // the reason its capture ended.
        let recording = recorder
            .current("app-notes")
            .expect("an ended recording is still the owner's");
        assert_eq!(recording.audio_blob_id, "blob_aaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(recording.device.device_id(), "Test Microphone");
        assert_eq!(
            recording.ended_reason,
            Some(EndedReason::DeviceDisconnected)
        );
    }

    /// The invariant that makes the slot safe: nothing may start on top of a
    /// recording whose audio nobody has claimed yet.
    #[test]
    fn an_ended_recording_still_refuses_a_competing_start() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );

        let live = recorder
            .require_free_slot()
            .expect_err("a live recording refuses a start");
        assert_eq!(error_name(&live), "Busy");

        recorder.end_capture("blob_aaaaaaaaaaaaaaaaaaaaa", EndedReason::PermissionRevoked);

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

    /// Stop is the one publication path, and it does not care whether the
    /// microphone is still open: the eight minutes captured before a device died
    /// come back through exactly the same call as a normal dictation.
    #[test]
    fn stopping_an_ended_recording_returns_what_it_captured() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );
        recorder.end_capture(
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            EndedReason::DeviceDisconnected,
        );

        let recorded = stop_and_publish(&mut recorder, "blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes")
            .expect("an ended recording is still the owner's to stop");
        assert_eq!(recorded.duration_ms, 1_000, "the captured second survived");
        assert!(
            root.path()
                .join("blob_aaaaaaaaaaaaaaaaaaaaa")
                .join("data")
                .exists(),
            "stopping an ended recording must publish what it captured"
        );

        // And stopping resolved it, so the slot is free again.
        assert!(recorder.current("app-notes").is_none());
        recorder
            .require_free_slot()
            .expect("a stopped recording releases the slot");
    }

    /// Cancel never publishes, on either side of a capture ending.
    #[test]
    fn cancelling_an_ended_recording_produces_nothing() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );
        recorder.end_capture("blob_aaaaaaaaaaaaaaaaaaaaa", EndedReason::StreamFailed);

        recorder
            .cancel("blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes")
            .expect("the owner may cancel an ended recording");
        assert!(recorder.current("app-notes").is_none());
    }

    /// A non-owner must not be able to reach an ended recording either. The
    /// window that started it is the only one that can decide its audio's fate.
    #[test]
    fn a_non_owner_cannot_resolve_an_ended_recording() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );
        recorder.end_capture(
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            EndedReason::DeviceDisconnected,
        );

        assert!(recorder.current("whispering").is_none());
        let error = recorder
            .stop("blob_aaaaaaaaaaaaaaaaaaaaa", "whispering")
            .expect_err("only the owner may claim the audio");
        assert_eq!(error_name(&error), "NotRecording");
        assert!(recorder.current("app-notes").is_some());
    }

    /// A stream error can arrive after its recording was already resolved and
    /// the owner started another one. Matching on the id keeps the late failure
    /// from ending the innocent successor's capture, and makes a repeated report
    /// a no-op rather than a second notification.
    #[test]
    fn ending_the_capture_of_a_stale_id_leaves_the_held_recording_alone() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_bbbbbbbbbbbbbbbbbbbbb",
            "app-notes",
        );

        assert_eq!(
            recorder.end_capture("blob_aaaaaaaaaaaaaaaaaaaaa", EndedReason::StreamFailed),
            None
        );
        assert!(recorder.is_capturing());
        assert_eq!(
            current_id(&recorder, "app-notes").as_deref(),
            Some("blob_bbbbbbbbbbbbbbbbbbbbb"),
        );

        // The first report of a real failure names the owner; the second finds
        // the capture already ended and says nothing, so the owner is told once.
        assert_eq!(
            recorder
                .end_capture("blob_bbbbbbbbbbbbbbbbbbbbb", EndedReason::StreamFailed)
                .as_deref(),
            Some("app-notes")
        );
        assert_eq!(
            recorder.end_capture(
                "blob_bbbbbbbbbbbbbbbbbbbbb",
                EndedReason::DeviceDisconnected
            ),
            None
        );
        // And the first reason stands: a repeat report cannot rewrite history.
        assert_eq!(
            recorder
                .current("app-notes")
                .and_then(|recording| recording.ended_reason),
            Some(EndedReason::StreamFailed)
        );
    }

    /// A recovered recording has to be able to say which microphone it opened,
    /// or a window that reloaded would show a meter for a device it cannot name.
    #[test]
    fn current_reports_the_device_the_recording_opened() {
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );

        let recording = recorder.current("app-notes").expect("a live recording");
        assert_eq!(recording.device.device_id(), "Test Microphone");
        assert_eq!(recording.ended_reason, None);
    }

    #[test]
    fn stopping_a_recording_that_already_ended_is_a_typed_refusal() {
        let mut recorder = Recorder::new();
        let error = recorder
            .stop("blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes")
            .expect_err("there is nothing to stop");
        assert_eq!(error_name(&error), "NotRecording");
    }

    #[test]
    fn downmix_stereo_to_mono_averages_pairs() {
        assert_eq!(downmix_f32(&[0.5, -0.5, 1.0, -1.0], 2), vec![0, 0]);
        assert_eq!(downmix_i16(&[1000, 2000, -400, -600], 2), vec![1500, -500]);
        // Offset binary: 32768 is silence, so an all-silence stereo frame is 0.
        assert_eq!(
            downmix_u16(&[32_768, 32_768, 65_535, 32_768], 2),
            vec![0, 16_383]
        );
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
        assert_eq!(
            downmix_u16(&[0, 32_768, 65_535], 1),
            vec![-32_768, 0, 32_767]
        );
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

    /// The one product behavior the staged rewrite had to carry across: Whisper
    /// hallucinates sentences into near-silent clips shorter than about a
    /// second, so short recordings are padded. It is expressed at the device's
    /// rate now, which is why the assertion is in seconds rather than samples.
    #[test]
    fn short_clips_are_padded_and_empty_ones_are_left_alone() {
        let root = staging_root();

        let short = capture_holding(&root, "blob_aaaaaaaaaaaaaaaaaaaaa", &[64; 100])
            .finish()
            .expect("finish a short clip");
        assert_eq!(short.duration_ms, 1_250);

        let empty = capture_holding(&root, "blob_bbbbbbbbbbbbbbbbbbbbb", &[])
            .finish()
            .expect("finish an empty clip");
        assert_eq!(
            empty.duration_ms, 0,
            "a recording that captured nothing must not be padded into looking real"
        );

        // Anything at or over a second is kept exactly as captured.
        let long = capture_holding(&root, "blob_ccccccccccccccccccccc", &tone(TEST_RATE, 2))
            .finish()
            .expect("finish a long clip");
        assert_eq!(long.duration_ms, 2_000);
    }

    /// The end-to-end claim this whole path rests on: a staged mono PCM16 file
    /// at the device's own rate is readable by the transcription decoder, which
    /// produces the 16 kHz mono it wants. If this fails, capturing at the device
    /// rate is not a valid refusal of the streaming resampler.
    #[test]
    fn a_published_capture_decodes_to_16_khz_mono() {
        let root = staging_root();
        let id = "blob_aaaaaaaaaaaaaaaaaaaaa";

        let stopped = capture_holding(&root, id, &tone(TEST_RATE, 1))
            .finish()
            .expect("finish the capture");
        assert_eq!(stopped.duration_ms, 1_000);
        let byte_length = stopped
            .staged
            .publish("audio/wav")
            .expect("publish the blob");

        let published = root.path().join(id).join("data");
        let bytes = std::fs::read(&published).expect("read the published blob");
        assert_eq!(bytes.len() as u64, byte_length);
        // 44-byte canonical PCM header plus one second of 48 kHz mono PCM16.
        assert_eq!(bytes.len(), 44 + (TEST_RATE as usize * 2));

        let samples = decode_to_pcm16k_mono(&bytes).expect("decode the published blob");
        assert!(
            samples.len().abs_diff(16_000) <= 1,
            "expected about a second of 16 kHz mono, got {} samples",
            samples.len()
        );
        // The tone survived: a decoded silent buffer would mean the header
        // described bytes the writer never wrote.
        let peak = samples.iter().fold(0f32, |peak, s| peak.max(s.abs()));
        assert!(peak > 0.4, "the decoded tone is too quiet: peak {peak}");
    }

    /// Publication is atomic and one-way: nothing is readable at the id until
    /// the rename, and a cancelled recording leaves no trace of either.
    #[test]
    fn staging_becomes_a_blob_only_at_publish_and_never_at_cancel() {
        let root = staging_root();
        let published_id = "blob_aaaaaaaaaaaaaaaaaaaaa";
        let cancelled_id = "blob_bbbbbbbbbbbbbbbbbbbbb";

        let capture = capture_holding(&root, published_id, &tone(TEST_RATE, 1));
        assert!(
            !root.path().join(published_id).exists(),
            "a recording in progress must not be visible at its id"
        );
        capture
            .finish()
            .expect("finish")
            .staged
            .publish("audio/wav")
            .expect("publish");
        assert!(root.path().join(published_id).join("data").exists());
        assert!(root
            .path()
            .join(published_id)
            .join("metadata.json")
            .exists());

        capture_holding(&root, cancelled_id, &tone(TEST_RATE, 1)).discard();
        assert!(
            !root.path().join(cancelled_id).exists(),
            "cancel must never publish"
        );

        // Both recordings are resolved, so no staging is left holding bytes.
        let staged: Vec<_> = std::fs::read_dir(root.path().join(".staging").join("rust"))
            .expect("the staging root")
            .map(|entry| entry.expect("a staging entry").path())
            .collect();
        assert!(staged.is_empty(), "staging left behind: {staged:?}");
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
        let root = staging_root();
        let mut capture = capture_holding(&root, "blob_aaaaaaaaaaaaaaaaaaaaa", &[]);
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
        let root = staging_root();
        let mut capture = capture_holding(&root, "blob_aaaaaaaaaaaaaaaaaaaaa", &[]);
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
        let root = staging_root();
        let mut capture = capture_holding(&root, "blob_aaaaaaaaaaaaaaaaaaaaa", &tone(TEST_RATE, 2));
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
        let root = staging_root();
        let mut recorder = Recorder::new();
        recording_owned_by(
            &mut recorder,
            &root,
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "app-notes",
        );

        let finalized = recorder
            .stop("blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes")
            .expect("the owner may stop its recording");

        // The worker is gone, not merely asked to go, and only now is the slot
        // admissible again.
        assert!(recorder.active.is_none());
        recorder
            .require_free_slot()
            .expect("a stopped recording releases the slot");

        // Publication is what happens after, outside any lock.
        let recorded = finalized.publish().expect("publish");
        assert_eq!(recorded.duration_ms, 1_000);
        assert!(recorded.byte_length > 44);
    }

    /// Startup sweeps staging and only staging. A partial capture left by a dead
    /// host is deleted; a blob that was published before the crash is a blob and
    /// stays one.
    #[test]
    fn stale_staging_is_deleted_at_startup_and_published_blobs_are_not() {
        let root = staging_root();
        let published_id = "blob_aaaaaaaaaaaaaaaaaaaaa";
        let abandoned_id = "blob_bbbbbbbbbbbbbbbbbbbbb";

        capture_holding(&root, published_id, &tone(TEST_RATE, 1))
            .finish()
            .expect("finish")
            .staged
            .publish("audio/wav")
            .expect("publish");
        // A capture the host died in the middle of: staged, never finalized.
        let abandoned = capture_holding(&root, abandoned_id, &tone(TEST_RATE, 1));
        std::mem::forget(abandoned);

        crate::blobs::delete_staging_root(root.path());

        assert!(
            root.path().join(published_id).join("data").exists(),
            "a published blob is not staging debris"
        );
        assert!(
            !root.path().join(".staging").join("rust").exists(),
            "the sweep must leave no staged capture behind"
        );
        assert!(
            !root.path().join(abandoned_id).exists(),
            "the sweep deletes; it never promotes a partial capture to a blob"
        );
    }
}
