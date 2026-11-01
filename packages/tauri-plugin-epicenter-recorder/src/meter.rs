//! A microphone opened only to read its level, for a page testing it.
//!
//! Nothing is recorded, written, or sent but the level. The stream is built
//! the way a recording builds it (the same device, configuration, and
//! callback), and its level goes over the channel the page passed: `{ kind: 'level' }` at most twenty times a second (one
//! per audio callback once 50 ms have passed, so fewer when the device's
//! callbacks are long), and `{ kind: 'ended' }` once if the stream dies on its
//! own. The meter is
//! closed by the page, or when its page reloads or its window is destroyed.
//! A meter whose stream dies, or whose page stops hearing its level, closes
//! itself: it calls back to be dropped, so no microphone stays open for a page
//! that is not listening.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::StreamTrait;
use log::debug;
use tauri::ipc::Channel;

use crate::ended::{EndedReason, RecordingSignal};
use crate::error::RecorderError;
use crate::recorder::{build_input_stream, input_config, resolve_device, ChunkSink, Result};

/// How many chunks may wait for the meter's worker. A meter keeps nothing, so
/// a short queue is enough; a full one drops chunks, which costs a level.
const METER_QUEUE_CHUNKS: usize = 20;

/// The least time between two levels sent to a page.
///
/// The page hears the level over the channel it passed to `open_meter`,
/// which reaches that page alone; the JS side never sees the PCM, so the
/// level has to originate here.
///
/// A level is sent with the first audio callback after this much time, so at
/// most twenty a second, and fewer when the device's callbacks are long. That
/// is smooth for a meter and keeps the channel off the IPC hot path (per
/// Tauri's guidance to throttle high-frequency messages). Levels between
/// sends are averaged, not dropped, so a brief loud transient still registers.
const MIC_LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(50);

/// The microphone's loudness since the last level was sent: the root mean
/// square of every sample in between, so a brief loud transient still
/// registers. A meter sends it at most once per [`MIC_LEVEL_EMIT_INTERVAL`].
struct Level {
    sum_of_squares: f64,
    samples: usize,
    last_sent: Instant,
}

impl Level {
    fn new() -> Self {
        Self {
            sum_of_squares: 0.0,
            samples: 0,
            last_sent: Instant::now(),
        }
    }

    fn add(&mut self, samples: &[i16]) {
        for &sample in samples {
            let normalized = sample as f64 / 32_768.0;
            self.sum_of_squares += normalized * normalized;
        }
        self.samples += samples.len();
    }

    /// The level to send at `now`, from 0 to 1, if one is due and anything
    /// was heard since the last; taking it starts the next interval.
    fn take(&mut self, now: Instant) -> Option<f32> {
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

/// What `open_meter` answers: the id to close it by, and the name of the
/// microphone it opened.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenedMeter {
    pub id: String,
    pub device: String,
}

/// One open meter. Dropping it closes the stream and joins its worker, so
/// the microphone is released by the time the drop returns.
pub(crate) struct Meter {
    stop_tx: Option<mpsc::Sender<()>>,
    worker: Option<JoinHandle<()>>,
    /// Set by the worker when it stopped on its own.
    gone: Arc<AtomicBool>,
}

impl Meter {
    /// A meter with a worker that only waits to be stopped, for tests that
    /// check who may close one without a microphone.
    #[cfg(test)]
    pub(crate) fn stand_in() -> Self {
        Self::stand_in_with(false)
    }

    /// A stand-in whose worker already stopped on its own.
    #[cfg(test)]
    pub(crate) fn stand_in_gone() -> Self {
        Self::stand_in_with(true)
    }

    #[cfg(test)]
    fn stand_in_with(gone: bool) -> Self {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let worker = thread::spawn(move || {
            let _ = stop_rx.recv();
        });
        Self {
            stop_tx: Some(stop_tx),
            worker: Some(worker),
            gone: Arc::new(AtomicBool::new(gone)),
        }
    }

    /// Whether the worker already stopped on its own.
    pub(crate) fn is_gone(&self) -> bool {
        self.gone.load(Ordering::Acquire)
    }
}

impl Drop for Meter {
    fn drop(&mut self) {
        // Dropping the sender is the stop: the worker sees it disconnected.
        self.stop_tx.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Open the microphone whose id is `requested`, or the system default, and
/// send its level on `signals` until the meter is dropped. Answers the meter
/// and the name of the microphone it opened.
///
/// When the stream dies or a level cannot be sent, the worker stops and calls
/// `on_gone` from a thread of its own, which drops the meter: dropping joins
/// the worker, so it cannot happen on the worker's thread.
///
/// The stream is built on the worker, as a recording's is, and its outcome
/// reported back, so a microphone that cannot open is refused here with the
/// classified error.
pub(crate) fn open(
    requested: Option<&str>,
    signals: Channel<RecordingSignal>,
    on_gone: impl FnOnce() + Send + 'static,
) -> Result<(Meter, String)> {
    let host = cpal::default_host();
    let (device, name) = resolve_device(&host, requested)?;
    let config = input_config(&device)?;
    let sample_format = config.sample_format();
    let channels = config.channels();
    let stream_config = cpal::StreamConfig {
        channels,
        sample_rate: config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };

    let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<i16>>(METER_QUEUE_CHUNKS);
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ended_tx, ended_rx) = mpsc::channel::<EndedReason>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
    let sink = ChunkSink {
        sample_tx,
        dropped_chunks: Arc::new(AtomicU32::new(0)),
    };
    let on_error = move |error: cpal::Error| match crate::ended::classify(&error) {
        Some(reason) => {
            let _ = ended_tx.send(reason);
        }
        None => debug!("Meter stream reported a survivable condition: {error}"),
    };

    let gone = Arc::new(AtomicBool::new(false));
    let worker_gone = Arc::clone(&gone);
    let stopped_on_its_own = move || {
        worker_gone.store(true, Ordering::Release);
        thread::spawn(on_gone);
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
        let mut level = Level::new();
        loop {
            match stop_rx.try_recv() {
                Err(mpsc::TryRecvError::Empty) => {}
                // Stopped, or the meter is gone: the stream drops with this frame.
                _ => return,
            }
            if let Ok(reason) = ended_rx.try_recv() {
                drop(stream);
                let _ = signals.send(RecordingSignal::Ended { reason });
                stopped_on_its_own();
                return;
            }
            match sample_rx.recv_timeout(Duration::from_millis(20)) {
                Ok(samples) => {
                    level.add(&samples);
                    if let Some(level) = level.take(Instant::now()) {
                        // A page that cannot hear the level is gone: the
                        // microphone is not kept open for nobody.
                        if signals.send(RecordingSignal::Level { level }).is_err() {
                            drop(stream);
                            stopped_on_its_own();
                            return;
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });

    let meter = Meter {
        stop_tx: Some(stop_tx),
        worker: Some(worker),
        gone,
    };
    match ready_rx.recv() {
        Ok(Ok(())) => Ok((meter, name)),
        // The worker has returned, so dropping the meter joins it at once.
        Ok(Err(error)) => Err(error),
        Err(error) => Err(RecorderError::failed(format!(
            "meter worker exited before reporting stream readiness: {error}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
