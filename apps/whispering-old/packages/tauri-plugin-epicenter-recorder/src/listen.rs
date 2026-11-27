//! Hands-free: the microphone stays open, and each phrase spoken into it
//! becomes a take of its own.
//!
//! ```text
//! cpal callback ─▶ worker: convert to 16 kHz ─▶ detector (16 ms frames)
//!                    │
//!                    ├─ waiting: keep the last half second (the pre-roll)
//!                    ├─ speech starts: tell the page, keep what is heard in
//!                    │  memory until the page names the take
//!                    ├─ named: write the pre-roll, then each chunk, into
//!                    │  `recordings/<id>.webm`
//!                    └─ a pause: finish the take, tell the page, wait again
//! ```
//!
//! The pre-roll is why this lives beside the recorder instead of in the
//! page: a detector needs a few frames to be sure it hears a voice, and a
//! microphone opened only then would lose the first syllable. Here the
//! stream never closes between phrases, so nothing is lost at either end.
//!
//! The page names each take, when it hears speech has started, so a
//! recording's id still starts with the time it began and the page stays the
//! one place an id is made. Until the name arrives the phrase waits in
//! memory, which is a few milliseconds of audio in practice.
//!
//! A listener holds the host's one recorder slot, as a recording does: a
//! `start` while it listens is refused `Busy`, and so is a `listen` while a
//! recording is held. Like a recording, its phrase is finished in place when
//! its page leaves or the app exits, and nothing here deletes a file that
//! holds audio.

use std::collections::VecDeque;
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

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
    StoppedRecording, RECORDING_RATE,
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

/// The most a phrase may hold in memory while it waits for its name. A page
/// answers in milliseconds; past thirty seconds it is not going to.
const UNNAMED_LIMIT: usize = RECORDING_RATE as usize * 30;

/// How many callback chunks may wait for the worker: about two seconds.
const LISTEN_QUEUE_CHUNKS: usize = 200;

/// What a listener tells its page over the channel it passed to `listen`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ListenSignal {
    /// The microphone's level since the last one, from 0 to 1.
    Level { level: f32 },
    /// A phrase has started. The page answers with `name_phrase`.
    Speech,
    /// A phrase ended on a pause, and its take is finished at its path.
    Phrase { recording: StoppedRecording },
    /// The microphone, or the disk, stopped on its own, and why. Nothing more
    /// is heard; `unlisten` answers a take that was being written.
    Ended { reason: EndedReason },
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
}

impl<F: FnMut(&[i16]) -> f32> Phrases<F> {
    pub(crate) fn new(score: F) -> Self {
        Self {
            score,
            frame: Vec::with_capacity(FRAME),
            voiced_run: 0,
            quiet_run: 0,
            speaking: false,
        }
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
            if voiced {
                self.voiced_run += 1;
                self.quiet_run = 0;
                if !self.speaking && self.voiced_run >= ONSET_FRAMES {
                    self.speaking = true;
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

    /// Forget the phrase under way, so the next voice starts a new one.
    fn reset(&mut self) {
        self.voiced_run = 0;
        self.quiet_run = 0;
        self.speaking = false;
    }
}

enum Cmd {
    /// The page's name for the phrase that started: write it at `path`.
    Name {
        id: String,
        path: PathBuf,
        reply: mpsc::Sender<Result<()>>,
    },
    /// Stop listening; answers the take that was being written, finished.
    Stop(mpsc::Sender<Result<Option<StoppedRecording>>>),
    /// The stream died: release the microphone and wait to be stopped.
    EndCapture(EndedReason),
}

/// What the worker is doing with what it hears.
enum State {
    Waiting,
    /// A phrase has started and the page has not named it yet. `over` once
    /// it also ended, so its name finishes it at once.
    Unnamed {
        heard: Vec<i16>,
        over: bool,
    },
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
    /// and listen for phrases, telling `signals`.
    ///
    /// The stream is built on the worker, as a recording's is, and its
    /// outcome reported back, so a microphone that cannot open is refused
    /// here with the classified error.
    pub(crate) fn open(requested: Option<&str>, signals: Channel<ListenSignal>) -> Result<Self> {
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
            run(stream, &sample_rx, &cmd_rx, converter, phrases, &|signal| {
                // A page that cannot hear changes nothing here: its leaving
                // closes the listener.
                let _ = signals.send(signal);
            });
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

    /// Name the phrase that started `id`, to be written at `path`. Refused
    /// when no phrase is waiting for a name.
    pub(crate) fn name_phrase(&self, id: String, path: PathBuf) -> Result<()> {
        let (reply, answer) = mpsc::channel();
        self.cmd_tx
            .send(Cmd::Name { id, path, reply })
            .map_err(|_| RecorderError::not_recording("listening has stopped"))?;
        answer
            .recv()
            .map_err(|_| RecorderError::not_recording("listening has stopped"))?
    }

    /// Stop listening and release the microphone; answers the take that was
    /// being written, finished in place.
    pub(crate) fn close(mut self) -> Result<Option<StoppedRecording>> {
        self.stop()
    }

    fn stop(&mut self) -> Result<Option<StoppedRecording>> {
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
    tell: &dyn Fn(ListenSignal),
) where
    F: FnMut(&[i16]) -> f32,
{
    let mut stream = Some(stream);
    let mut state = State::Waiting;
    let mut pre_roll = VecDeque::<i16>::with_capacity(PRE_ROLL * 2);
    let mut level = Level::new();

    // Finish a phrase's take and tell the page; answers whether it could.
    let finish = |capture: Box<CaptureFile>, id: String| match capture.finish() {
        Ok(duration_ms) => {
            tell(ListenSignal::Phrase {
                recording: StoppedRecording { id, duration_ms },
            });
            true
        }
        Err(error) => {
            error!("The phrase {id} could not be finished: {error}");
            false
        }
    };

    loop {
        match cmd_rx.try_recv() {
            Ok(Cmd::Stop(reply)) => {
                drop(stream.take());
                let answer = match state {
                    State::Writing { capture, id } => capture
                        .finish()
                        .map(|duration_ms| Some(StoppedRecording { id, duration_ms })),
                    _ => Ok(None),
                };
                let _ = reply.send(answer);
                return;
            }
            Ok(Cmd::EndCapture(reason)) => {
                if stream.take().is_some() {
                    tell(ListenSignal::Ended { reason });
                }
            }
            Ok(Cmd::Name { id, path, reply }) => {
                state = match state {
                    State::Unnamed { heard, over } => match begin(path, &heard) {
                        Ok(capture) => {
                            let _ = reply.send(Ok(()));
                            // The microphone is gone, or the phrase already
                            // ended: nothing more will be added to it.
                            if !over && stream.is_some() {
                                State::Writing { capture, id }
                            } else {
                                if !finish(capture, id) && stream.take().is_some() {
                                    tell(ListenSignal::Ended {
                                        reason: EndedReason::StorageFailed,
                                    });
                                }
                                State::Waiting
                            }
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error));
                            phrases.reset();
                            State::Waiting
                        }
                    },
                    other => {
                        let _ = reply.send(Err(RecorderError::not_recording(
                            "no phrase is waiting for a name",
                        )));
                        other
                    }
                };
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

        state = match state {
            State::Waiting => {
                pre_roll.extend(&heard);
                if edge == Some(Edge::Started) {
                    tell(ListenSignal::Speech);
                    // Untrimmed: the chunk the phrase started in is all kept.
                    State::Unnamed {
                        heard: pre_roll.drain(..).collect(),
                        over: false,
                    }
                } else {
                    let excess = pre_roll.len().saturating_sub(PRE_ROLL);
                    pre_roll.drain(..excess);
                    State::Waiting
                }
            }
            State::Unnamed {
                heard: mut so_far,
                over,
            } => {
                so_far.extend(&heard);
                if so_far.len() > UNNAMED_LIMIT {
                    warn!("A phrase was never named by its page; it is dropped");
                    phrases.reset();
                    State::Waiting
                } else {
                    State::Unnamed {
                        heard: so_far,
                        over: match edge {
                            Some(Edge::Ended) => true,
                            Some(Edge::Started) => false,
                            None => over,
                        },
                    }
                }
            }
            State::Writing { mut capture, id } => {
                if let Err(error) = capture.write(&heard) {
                    // Terminal, as it is for a recording: the take keeps the
                    // whole seconds that reached the file, and `unlisten`
                    // answers why.
                    error!("The phrase {id} could not be written: {error}");
                    drop(stream.take());
                    tell(ListenSignal::Ended {
                        reason: EndedReason::StorageFailed,
                    });
                    State::Writing { capture, id }
                } else if edge == Some(Edge::Ended) {
                    if !finish(capture, id) {
                        drop(stream.take());
                        tell(ListenSignal::Ended {
                            reason: EndedReason::StorageFailed,
                        });
                    }
                    State::Waiting
                } else {
                    State::Writing { capture, id }
                }
            }
        };
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
    fn a_phrase_starts_after_a_run_of_voice_and_ends_after_a_pause() {
        let mut phrases = Phrases::new(by_loudness);
        assert_eq!(phrases.push(&frames(true, ONSET_FRAMES as usize - 1)), None);
        assert_eq!(phrases.push(&frames(true, 1)), Some(Edge::Started));
        assert_eq!(phrases.push(&frames(true, 20)), None, "still the same phrase");
        assert_eq!(
            phrases.push(&frames(false, QUIET_FRAMES as usize - 1)),
            None,
            "a short pause is part of the phrase"
        );
        assert_eq!(phrases.push(&frames(true, 1)), None);
        assert_eq!(
            phrases.push(&frames(false, QUIET_FRAMES as usize)),
            Some(Edge::Ended)
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

    /// A worker with no microphone: what to feed it, how to command it, and
    /// what it has told the page so far (levels left out).
    struct Worker {
        samples: mpsc::SyncSender<Vec<i16>>,
        cmd_tx: mpsc::Sender<Cmd>,
        told: Arc<Mutex<Vec<ListenSignal>>>,
        thread: JoinHandle<()>,
    }

    fn worker() -> Worker {
        let (samples, sample_rx) = mpsc::sync_channel::<Vec<i16>>(10_000);
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();
        let told = Arc::new(Mutex::new(Vec::new()));
        let heard = Arc::clone(&told);
        let thread = thread::spawn(move || {
            let tell = |signal: ListenSignal| {
                if !matches!(signal, ListenSignal::Level { .. }) {
                    heard.lock().unwrap().push(signal);
                }
            };
            // `()` stands in for the stream: only its drop matters.
            run((), &sample_rx, &cmd_rx, None, Phrases::new(by_loudness), &tell);
        });
        Worker {
            samples,
            cmd_tx,
            told,
            thread,
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
                assert!(Instant::now() < deadline, "the worker told {:?}", self.told());
                thread::sleep(Duration::from_millis(5));
            }
        }

        fn name(&self, id: &str, path: PathBuf) -> Result<()> {
            let (reply, answer) = mpsc::channel();
            self.cmd_tx
                .send(Cmd::Name {
                    id: id.to_string(),
                    path,
                    reply,
                })
                .unwrap();
            answer.recv().unwrap()
        }

        fn stop(self) -> Result<Option<StoppedRecording>> {
            let (reply, answer) = mpsc::channel();
            self.cmd_tx.send(Cmd::Stop(reply)).unwrap();
            let stopped = answer.recv().unwrap();
            self.thread.join().unwrap();
            stopped
        }
    }

    #[test]
    fn a_phrase_named_after_it_started_is_a_finished_take_with_its_pre_roll() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("a.webm");
        let worker = worker();
        worker.samples.send(frames(false, 100)).unwrap();
        worker.samples.send(frames(true, 125)).unwrap();
        worker.wait_for(1);
        assert_eq!(worker.told(), vec![ListenSignal::Speech]);
        worker.name("a", path.clone()).expect("named");
        worker
            .samples
            .send(frames(false, QUIET_FRAMES as usize))
            .unwrap();
        worker.wait_for(2);
        let told = worker.told();
        let ListenSignal::Phrase { recording } = &told[1] else {
            panic!("expected a phrase, was told {told:?}");
        };
        assert_eq!(recording.id, "a");
        // Two seconds spoken, the pause that ended it, and a pre-roll of
        // silence in front.
        let at_least = 2000 + QUIET_FRAMES * 16;
        let at_most = at_least + (PRE_ROLL as u32 * 1000 / RECORDING_RATE) + 100;
        assert!(
            (at_least..=at_most).contains(&recording.duration_ms),
            "{} ms is not within {at_least}..={at_most}",
            recording.duration_ms
        );
        assert!(path.exists());
        assert_eq!(worker.stop().unwrap(), None, "nothing is held between phrases");
    }

    #[test]
    fn stopping_mid_phrase_answers_the_take_and_a_name_with_no_phrase_is_refused() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("b.webm");
        let worker = worker();
        let refused = worker.name("early", folder.path().join("early.webm"));
        assert!(matches!(refused, Err(RecorderError::NotRecording { .. })));
        worker.samples.send(frames(true, 100)).unwrap();
        worker.wait_for(1);
        worker.name("b", path.clone()).expect("named");
        let stopped = worker.stop().expect("finished").expect("a take");
        assert_eq!(stopped.id, "b");
        assert!(stopped.duration_ms >= 1500);
        assert!(path.exists());
        assert!(!folder.path().join("early.webm").exists());
    }
}
