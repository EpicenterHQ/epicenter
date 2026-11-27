//! Hands-free: the microphone stays open, and each phrase spoken into it
//! becomes a take of its own.
//!
//! ```text
//! cpal callback ─▶ worker: convert to 16 kHz ─▶ detector (16 ms frames)
//!                    │
//!                    ├─ waiting: keep the last half second (the pre-roll)
//!                    ├─ speech starts: name the take, write the pre-roll
//!                    │  and then each chunk into `recordings/<id>.webm`,
//!                    │  and tell the page
//!                    └─ a pause: finish the take, tell the page, wait again
//! ```
//!
//! The pre-roll is why this lives beside the recorder instead of in the
//! page: a detector needs a few frames to be sure it hears a voice, and a
//! microphone opened only then would lose the first syllable. Here the
//! stream never closes between phrases, so nothing is lost at either end.
//!
//! The worker names each take itself ([`time_id`]), in the format the page
//! names a recording, from the moment its first sample was heard. A page
//! that named it would need a round trip while the phrase waited in memory,
//! and a slow or refused answer would lose the phrase.
//!
//! Each finished take says how long a voice was heard in it (`voicedMs`),
//! so the page can tell a cough from a sentence without transcribing it.
//!
//! A listener holds the host's one recorder slot, as a recording does: a
//! `start` while it listens is refused `Busy`, and so is a `listen` while a
//! recording is held. Like a recording, its phrase is finished in place when
//! its page leaves or the app exits, and nothing here deletes a file that
//! holds audio.

use std::collections::VecDeque;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cpal::traits::StreamTrait;
use log::{debug, error, warn};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::ended::EndedReason;
use crate::error::RecorderError;
use crate::meter::Level;
use crate::rate::RateConverter;
use crate::recorder::{
    build_input_stream, input_config, resolve_device, CaptureFile, ChunkSink, Result,
    RECORDING_RATE,
};

/// The detector reads frames of exactly this many samples: 16 ms at 16 kHz.
const FRAME: usize = 256;

/// A frame scoring at least this is a voice; the detector's own suggestion.
const VOICED: f32 = 0.5;

/// A phrase starts after this many voiced frames in a row (80 ms), so a
/// click or a key press starts nothing.
const ONSET_FRAMES: u32 = 5;

/// A phrase ends after this many frames in a row without a voice (1.2 s):
/// longer than a breath or a comma, shorter than waiting feels.
const QUIET_FRAMES: u32 = 75;

/// How much audio from before a phrase started is kept at its front: half a
/// second, which covers the frames the detector needed and a soft first
/// consonant before them.
const PRE_ROLL: usize = RECORDING_RATE as usize / 2;

/// The longest one phrase may run before it is cut: two minutes of frames.
/// Speech pauses long before that; music or a television beside the
/// microphone may never, and would otherwise be one take without end.
const MAX_FRAMES: u32 = 120 * RECORDING_RATE / FRAME as u32;

/// Past [`MAX_FRAMES`] a phrase is cut at the first frame without a voice,
/// so not mid-word, or after this many more frames (five seconds) whatever
/// they hold.
const CUT_WITHIN_FRAMES: u32 = 5 * RECORDING_RATE / FRAME as u32;

/// A pause is over only after this many voiced frames in a row: one noisy
/// frame in a pause does not keep a phrase going.
const RESUME_FRAMES: u32 = 2;

/// How long one frame lasts.
const FRAME_MS: u32 = FRAME as u32 * 1000 / RECORDING_RATE;

/// How many callback chunks may wait for the worker: about two seconds.
const LISTEN_QUEUE_CHUNKS: usize = 200;

/// What a listener tells its page over the channel it passed to `listen`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ListenSignal {
    /// The microphone's level since the last one, from 0 to 1.
    Level { level: f32 },
    /// A phrase has started, and its take is being written as `id`.
    Speech { id: String },
    /// A phrase ended on a pause, and its take is finished at its path.
    Phrase { take: HeardTake },
    /// The microphone, or the disk, stopped on its own, and why. Nothing more
    /// is heard; `unlisten` answers a take that was being written.
    Ended { reason: EndedReason },
}

/// A finished take that hands-free recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeardTake {
    /// The id the worker gave it: its audio is `recordings/<id>.webm`.
    pub id: String,
    pub duration_ms: u32,
    /// How long the detector heard a voice in it. A cough or a door is a
    /// few hundred milliseconds; a sentence is seconds.
    pub voiced_ms: u32,
}

/// A name for a take whose first sample was heard at `at`: the moment in
/// UTC to the millisecond, then 8 random lowercase letters and digits. It is
/// the format the page gives a recording (`timeId` in `@epicenter/app`), so
/// a take sorts and dates the same whoever named it.
///
/// ```text
/// 2026-10-30T22-41-05-123Z-k3x9a2f8
/// ```
pub(crate) fn time_id(at: SystemTime) -> String {
    let ms = at
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64);
    let (days, in_day) = (ms / 86_400_000, ms % 86_400_000);
    // Days since 1970 to a civil date (Howard Hinnant's `civil_from_days`).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);

    // The standard library's per-process random keys, hashed with the time.
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(ms);
    let mut random = hasher.finish();
    let suffix: String = (0..8)
        .map(|_| {
            let digit = (random % 36) as u32;
            random /= 36;
            char::from_digit(digit, 36).unwrap_or('0')
        })
        .collect();
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}-{:03}Z-{suffix}",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1_000 % 60,
        in_day % 1_000,
    )
}

/// Where a phrase begins or ends in what the detector has heard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Edge {
    Started,
    Ended,
}

/// Turns a stream of 16 kHz samples into the edges of the phrases in it.
/// `score` says how much a frame sounds like a voice, from 0 to 1.
pub(crate) struct Phrases<F> {
    score: F,
    /// Samples waiting for a whole frame.
    frame: Vec<i16>,
    voiced_run: u32,
    quiet_run: u32,
    speaking: bool,
    /// Frames in the phrase under way, and how many of them held a voice.
    frames: u32,
    voiced: u32,
}

impl<F: FnMut(&[i16]) -> f32> Phrases<F> {
    pub(crate) fn new(score: F) -> Self {
        Self {
            score,
            frame: Vec::with_capacity(FRAME),
            voiced_run: 0,
            quiet_run: 0,
            speaking: false,
            frames: 0,
            voiced: 0,
        }
    }

    /// How long a voice has been heard in the phrase under way, or in the
    /// one that just ended.
    pub(crate) fn voiced_ms(&self) -> u32 {
        self.voiced * FRAME_MS
    }

    /// Hear `samples`; answers the edge they crossed, if any. A phrase is far
    /// longer than one call's samples, so at most one edge is crossed.
    pub(crate) fn push(&mut self, samples: &[i16]) -> Option<Edge> {
        let mut edge = None;
        for &sample in samples {
            self.frame.push(sample);
            if self.frame.len() < FRAME {
                continue;
            }
            let voiced = (self.score)(&self.frame) >= VOICED;
            self.frame.clear();
            if self.speaking {
                self.frames += 1;
                self.voiced += u32::from(voiced);
                let over = self.frames >= MAX_FRAMES;
                if over && (!voiced || self.frames >= MAX_FRAMES + CUT_WITHIN_FRAMES) {
                    // Cut here; a voice still going starts the next phrase,
                    // and the frames it takes to be sure are its pre-roll.
                    self.speaking = false;
                    self.voiced_run = 0;
                    self.quiet_run = 0;
                    edge = Some(Edge::Ended);
                    continue;
                }
            }
            if voiced {
                self.voiced_run += 1;
                if self.voiced_run >= RESUME_FRAMES {
                    self.quiet_run = 0;
                }
                if !self.speaking && self.voiced_run >= ONSET_FRAMES {
                    self.speaking = true;
                    self.frames = ONSET_FRAMES;
                    self.voiced = ONSET_FRAMES;
                    edge = Some(Edge::Started);
                }
            } else {
                self.voiced_run = 0;
                if self.speaking {
                    self.quiet_run += 1;
                    if self.quiet_run >= QUIET_FRAMES {
                        self.speaking = false;
                        self.quiet_run = 0;
                        edge = Some(Edge::Ended);
                    }
                }
            }
        }
        edge
    }
}

enum Cmd {
    /// Stop listening; answers the take that was being written, finished.
    Stop(mpsc::Sender<Result<Option<HeardTake>>>),
    /// The stream died: release the microphone and wait to be stopped.
    EndCapture(EndedReason),
}

/// What the worker is doing with what it hears.
enum State {
    Waiting,
    Writing {
        capture: Box<CaptureFile>,
        id: String,
    },
}

/// One open listener. Dropping it stops it, finishing a take under way.
pub(crate) struct Listener {
    cmd_tx: mpsc::Sender<Cmd>,
    worker: Option<JoinHandle<()>>,
}

impl Listener {
    /// Open the microphone whose id is `requested`, or the system default,
    /// and listen for phrases, telling `signals`. Each take is written in
    /// `takes`, a directory that exists.
    ///
    /// The stream is built on the worker, as a recording's is, and its
    /// outcome reported back, so a microphone that cannot open is refused
    /// here with the classified error.
    pub(crate) fn open(
        requested: Option<&str>,
        takes: PathBuf,
        signals: Channel<ListenSignal>,
    ) -> Result<Self> {
        let host = cpal::default_host();
        let (device, _name) = resolve_device(&host, requested)?;
        let config = input_config(&device)?;
        let sample_format = config.sample_format();
        let channels = config.channels();
        let device_rate = config.sample_rate();
        let stream_config = cpal::StreamConfig {
            channels,
            sample_rate: device_rate,
            buffer_size: cpal::BufferSize::Default,
        };
        let converter = if device_rate == RECORDING_RATE {
            None
        } else {
            Some(RateConverter::new(device_rate, RECORDING_RATE)?)
        };

        let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<i16>>(LISTEN_QUEUE_CHUNKS);
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
        let sink = ChunkSink {
            sample_tx,
            dropped_chunks: Arc::new(AtomicU32::new(0)),
        };
        // Straight to the worker: nothing here needs the recorder's lock.
        let ended_tx = cmd_tx.clone();
        let on_error = move |error: cpal::Error| match crate::ended::classify(&error) {
            Some(reason) => {
                let _ = ended_tx.send(Cmd::EndCapture(reason));
            }
            None => debug!("Listening stream reported a survivable condition: {error}"),
        };

        let worker = thread::spawn(move || {
            let opened = build_input_stream(
                &device,
                stream_config,
                sample_format,
                channels,
                sink,
                on_error,
            )
            .and_then(|stream| {
                stream
                    .play()
                    .map_err(|e| RecorderError::classify_cpal("Failed to start stream", e))?;
                Ok(stream)
            });
            let stream = match opened {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    stream
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let mut detector = earshot::Detector::default();
            let phrases = Phrases::new(move |frame: &[i16]| detector.predict_i16(frame));
            run(
                stream,
                &sample_rx,
                &cmd_rx,
                converter,
                phrases,
                &takes,
                &|signal| {
                    // A page that cannot hear changes nothing here: its leaving
                    // closes the listener.
                    let _ = signals.send(signal);
                },
            );
        });

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                cmd_tx,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(error) => {
                let _ = worker.join();
                Err(RecorderError::failed(format!(
                    "listening worker exited before reporting stream readiness: {error}"
                )))
            }
        }
    }

    /// Stop listening and release the microphone; answers the take that was
    /// being written, finished in place.
    pub(crate) fn close(mut self) -> Result<Option<HeardTake>> {
        self.stop()
    }

    fn stop(&mut self) -> Result<Option<HeardTake>> {
        let Some(worker) = self.worker.take() else {
            return Ok(None);
        };
        let (reply, answer) = mpsc::channel();
        let stopped = match self.cmd_tx.send(Cmd::Stop(reply)) {
            Ok(()) => answer.recv().unwrap_or(Ok(None)),
            Err(_) => Ok(None),
        };
        // Joined, so the microphone is released by the time this answers.
        let _ = worker.join();
        stopped
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            warn!("The phrase held when listening closed could not be finished: {error}");
        }
    }
}

/// Create the take at `path` and write `heard`, the phrase so far, into it.
fn begin(path: PathBuf, heard: &[i16]) -> Result<Box<CaptureFile>> {
    let file = File::options()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => {
                RecorderError::refused(format!("a file is already at {}", path.display()))
            }
            _ => RecorderError::failed(format!("create {}: {error}", path.display())),
        })?;
    let mut capture = Box::new(CaptureFile::open(path, file, RECORDING_RATE)?);
    capture.write(heard)?;
    Ok(capture)
}

/// The worker's loop. Generic over the stream, of which only the drop
/// matters, and over the detector and the page, so a test drives it with
/// samples and no microphone.
fn run<S, F>(
    stream: S,
    sample_rx: &mpsc::Receiver<Vec<i16>>,
    cmd_rx: &mpsc::Receiver<Cmd>,
    mut converter: Option<RateConverter>,
    mut phrases: Phrases<F>,
    takes: &std::path::Path,
    tell: &dyn Fn(ListenSignal),
) where
    F: FnMut(&[i16]) -> f32,
{
    let mut stream = Some(stream);
    let mut state = State::Waiting;
    let mut pre_roll = VecDeque::<i16>::with_capacity(PRE_ROLL * 2);
    let mut level = Level::new();

    loop {
        match cmd_rx.try_recv() {
            Ok(Cmd::Stop(reply)) => {
                drop(stream.take());
                let answer = match state {
                    State::Writing { capture, id } => capture.finish().map(|duration_ms| {
                        Some(HeardTake {
                            id,
                            duration_ms,
                            voiced_ms: phrases.voiced_ms(),
                        })
                    }),
                    State::Waiting => Ok(None),
                };
                let _ = reply.send(answer);
                return;
            }
            Ok(Cmd::EndCapture(reason)) => {
                if stream.take().is_some() {
                    tell(ListenSignal::Ended { reason });
                }
            }
            // The listener is gone without a stop: keep what was being written.
            Err(mpsc::TryRecvError::Disconnected) => {
                drop(stream.take());
                if let State::Writing { capture, .. } = state {
                    let _ = capture.finish();
                }
                return;
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }

        let samples = match sample_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(samples) => samples,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            // The stream is closed; only a stop is left to wait for.
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
        };
        // What was queued when the capture ended is not part of any phrase.
        if stream.is_none() {
            continue;
        }
        level.add(&samples);
        if let Some(level) = level.take(Instant::now()) {
            tell(ListenSignal::Level { level });
        }
        let heard = match converter.as_mut() {
            Some(converter) => match converter.push(&samples) {
                Ok(converted) => converted,
                Err(error) => {
                    warn!("Listening could not convert a chunk: {error}");
                    continue;
                }
            },
            None => samples,
        };
        let edge = phrases.push(&heard);

        // The disk failing is terminal, as it is for a recording: the
        // microphone closes, the page is told, and a take under way keeps
        // the whole seconds that reached its file until `unlisten`.
        let mut storage_failed = false;
        state = match state {
            State::Waiting => {
                pre_roll.extend(&heard);
                if edge == Some(Edge::Started) {
                    // Untrimmed: the chunk the phrase started in is all kept.
                    let so_far: Vec<i16> = pre_roll.drain(..).collect();
                    let began = SystemTime::now()
                        - Duration::from_millis(
                            so_far.len() as u64 * 1000 / u64::from(RECORDING_RATE),
                        );
                    let id = time_id(began);
                    match begin(takes.join(format!("{id}.webm")), &so_far) {
                        Ok(capture) => {
                            tell(ListenSignal::Speech { id: id.clone() });
                            State::Writing { capture, id }
                        }
                        Err(error) => {
                            error!("The phrase {id} could not be started: {error}");
                            storage_failed = true;
                            State::Waiting
                        }
                    }
                } else {
                    let excess = pre_roll.len().saturating_sub(PRE_ROLL);
                    pre_roll.drain(..excess);
                    State::Waiting
                }
            }
            State::Writing { mut capture, id } => {
                if let Err(error) = capture.write(&heard) {
                    error!("The phrase {id} could not be written: {error}");
                    storage_failed = true;
                    State::Writing { capture, id }
                } else if edge == Some(Edge::Ended) {
                    match capture.finish() {
                        Ok(duration_ms) => tell(ListenSignal::Phrase {
                            take: HeardTake {
                                id,
                                duration_ms,
                                voiced_ms: phrases.voiced_ms(),
                            },
                        }),
                        Err(error) => {
                            error!("The phrase {id} could not be finished: {error}");
                            storage_failed = true;
                        }
                    }
                    State::Waiting
                } else {
                    State::Writing { capture, id }
                }
            }
        };
        if storage_failed {
            drop(stream.take());
            tell(ListenSignal::Ended {
                reason: EndedReason::StorageFailed,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A frame's worth of samples that the test detector calls a voice (1)
    /// or not (0).
    fn frames(voiced: bool, count: usize) -> Vec<i16> {
        vec![if voiced { 1000 } else { 0 }; FRAME * count]
    }

    /// A detector that hears a voice in any frame that is not silence.
    fn by_loudness(frame: &[i16]) -> f32 {
        if frame[0] != 0 {
            1.0
        } else {
            0.0
        }
    }

    #[test]
    fn a_take_is_named_as_the_page_names_one() {
        let at = UNIX_EPOCH + Duration::from_millis(1_793_400_065_123);
        let id = time_id(at);
        let (stamp, random) = id.split_at(25);
        assert_eq!(stamp, "2026-10-30T22-41-05-123Z-");
        assert_eq!(random.len(), 8);
        assert!(random
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()));
        assert_ne!(id, time_id(at), "two names made in one millisecond differ");
        // A leap day, and the first moment there is.
        let leap = UNIX_EPOCH + Duration::from_secs(1_709_164_800);
        assert!(time_id(leap).starts_with("2024-02-29T00-00-00-000Z-"));
        assert!(time_id(UNIX_EPOCH).starts_with("1970-01-01T00-00-00-000Z-"));
    }

    #[test]
    fn a_phrase_starts_after_a_run_of_voice_and_ends_after_a_pause() {
        let mut phrases = Phrases::new(by_loudness);
        assert_eq!(phrases.push(&frames(true, ONSET_FRAMES as usize - 1)), None);
        assert_eq!(phrases.push(&frames(true, 1)), Some(Edge::Started));
        assert_eq!(
            phrases.push(&frames(true, 20)),
            None,
            "still the same phrase"
        );
        assert_eq!(
            phrases.push(&frames(false, QUIET_FRAMES as usize - 1)),
            None,
            "a short pause is part of the phrase"
        );
        assert_eq!(phrases.push(&frames(true, 2)), None, "talking again");
        assert_eq!(
            phrases.push(&frames(false, QUIET_FRAMES as usize - 1)),
            None,
            "the pause is counted again from the start"
        );
        assert_eq!(phrases.push(&frames(true, 1)), None, "one noisy frame");
        assert_eq!(
            phrases.push(&frames(false, 1)),
            Some(Edge::Ended),
            "which does not keep the phrase going"
        );
        assert_eq!(
            phrases.voiced_ms(),
            (ONSET_FRAMES + 23) * FRAME_MS,
            "only the frames with a voice in them count"
        );
    }

    #[test]
    fn a_click_starts_nothing() {
        let mut phrases = Phrases::new(by_loudness);
        for _ in 0..10 {
            assert_eq!(phrases.push(&frames(true, ONSET_FRAMES as usize - 1)), None);
            assert_eq!(phrases.push(&frames(false, 1)), None);
        }
    }

    #[test]
    fn a_voice_that_never_pauses_is_cut_and_starts_the_next_phrase() {
        let mut phrases = Phrases::new(by_loudness);
        assert_eq!(
            phrases.push(&frames(true, ONSET_FRAMES as usize)),
            Some(Edge::Started)
        );
        let rest = (MAX_FRAMES + CUT_WITHIN_FRAMES - ONSET_FRAMES) as usize;
        assert_eq!(phrases.push(&frames(true, rest - 1)), None);
        assert_eq!(phrases.push(&frames(true, 1)), Some(Edge::Ended));
        assert_eq!(
            phrases.push(&frames(true, ONSET_FRAMES as usize)),
            Some(Edge::Started)
        );
    }

    #[test]
    fn a_long_phrase_is_cut_at_its_first_quiet_frame_past_the_limit() {
        let mut phrases = Phrases::new(by_loudness);
        phrases.push(&frames(true, MAX_FRAMES as usize + 10));
        assert_eq!(phrases.push(&frames(false, 1)), Some(Edge::Ended));
    }

    /// A worker with no microphone: what to feed it, how to command it, and
    /// what it has told the page so far (levels left out).
    struct Worker {
        samples: mpsc::SyncSender<Vec<i16>>,
        cmd_tx: mpsc::Sender<Cmd>,
        told: Arc<Mutex<Vec<ListenSignal>>>,
        thread: JoinHandle<()>,
        takes: tempfile::TempDir,
    }

    fn worker() -> Worker {
        let (samples, sample_rx) = mpsc::sync_channel::<Vec<i16>>(10_000);
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();
        let told = Arc::new(Mutex::new(Vec::new()));
        let heard = Arc::clone(&told);
        let takes = tempfile::tempdir().unwrap();
        let folder = takes.path().to_path_buf();
        let thread = thread::spawn(move || {
            let tell = |signal: ListenSignal| {
                if !matches!(signal, ListenSignal::Level { .. }) {
                    heard.lock().unwrap().push(signal);
                }
            };
            // `()` stands in for the stream: only its drop matters.
            run(
                (),
                &sample_rx,
                &cmd_rx,
                None,
                Phrases::new(by_loudness),
                &folder,
                &tell,
            );
        });
        Worker {
            samples,
            cmd_tx,
            told,
            thread,
            takes,
        }
    }

    impl Worker {
        fn told(&self) -> Vec<ListenSignal> {
            self.told.lock().unwrap().clone()
        }

        /// Wait until the page has been told `count` signals.
        fn wait_for(&self, count: usize) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.told().len() < count {
                assert!(
                    Instant::now() < deadline,
                    "the worker told {:?}",
                    self.told()
                );
                thread::sleep(Duration::from_millis(5));
            }
        }

        fn take_path(&self, id: &str) -> PathBuf {
            self.takes.path().join(format!("{id}.webm"))
        }

        fn stop(self) -> (Result<Option<HeardTake>>, tempfile::TempDir) {
            let (reply, answer) = mpsc::channel();
            self.cmd_tx.send(Cmd::Stop(reply)).unwrap();
            let stopped = answer.recv().unwrap();
            self.thread.join().unwrap();
            (stopped, self.takes)
        }
    }

    #[test]
    fn a_phrase_is_a_finished_take_with_its_pre_roll_and_how_long_a_voice_was_heard() {
        let worker = worker();
        worker.samples.send(frames(false, 100)).unwrap();
        worker.samples.send(frames(true, 125)).unwrap();
        worker
            .samples
            .send(frames(false, QUIET_FRAMES as usize))
            .unwrap();
        worker.wait_for(2);
        let told = worker.told();
        let ListenSignal::Speech { id } = &told[0] else {
            panic!("expected speech, was told {told:?}");
        };
        let ListenSignal::Phrase { take } = &told[1] else {
            panic!("expected a phrase, was told {told:?}");
        };
        assert_eq!(&take.id, id);
        assert_eq!(take.voiced_ms, 2000);
        // Two seconds spoken, the pause that ended it, and a pre-roll of
        // silence in front.
        let at_least = 2000 + QUIET_FRAMES * FRAME_MS;
        let at_most = at_least + (PRE_ROLL as u32 * 1000 / RECORDING_RATE) + 100;
        assert!(
            (at_least..=at_most).contains(&take.duration_ms),
            "{} ms is not within {at_least}..={at_most}",
            take.duration_ms
        );
        assert!(worker.take_path(id).exists());
        let (stopped, _takes) = worker.stop();
        assert_eq!(stopped.unwrap(), None, "nothing is held between phrases");
    }

    #[test]
    fn stopping_mid_phrase_answers_the_take() {
        let worker = worker();
        worker.samples.send(frames(true, 100)).unwrap();
        worker.wait_for(1);
        let ListenSignal::Speech { id } = worker.told().remove(0) else {
            panic!("expected speech");
        };
        let path = worker.take_path(&id);
        let (stopped, _takes) = worker.stop();
        let take = stopped.expect("finished").expect("a take");
        assert_eq!(take.id, id);
        assert!(take.duration_ms >= 1500);
        assert_eq!(take.voiced_ms, 1600);
        assert!(path.exists());
    }

    #[test]
    fn a_take_that_cannot_be_created_ends_listening_and_says_so() {
        let worker = worker();
        std::fs::remove_dir(worker.takes.path()).unwrap();
        worker.samples.send(frames(true, 100)).unwrap();
        worker.wait_for(1);
        assert_eq!(
            worker.told(),
            vec![ListenSignal::Ended {
                reason: EndedReason::StorageFailed
            }]
        );
    }
}
