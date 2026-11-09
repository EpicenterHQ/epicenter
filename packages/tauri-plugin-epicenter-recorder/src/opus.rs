//! Encoding a recording to Opus as it records, kept in WebM (`webm.rs`).
//!
//! Voice at 24 kbps, variable rate, in 20 ms packets: about 10.5 MB an
//! hour of speech, and the same words to a transcriber. Each 20 ms is
//! encoded as soon as it is captured, so Stop encodes only the last few
//! milliseconds. libopus is the copy `audiopus_sys` bundles, built from
//! source (`.cargo/config.toml`), not whatever a package manager installed.
//!
//! Opus delays what it encodes by its lookahead, which the file states as
//! the pre-skip a decoder drops, and its last packet is padded to a whole
//! 20 ms, which the file trims. What plays is the samples written, exactly.

use audiopus::coder::Encoder;
use audiopus::{Application, Bitrate, Channels, SampleRate};

use crate::recorder::RECORDING_RATE;
use crate::webm::{LiveWebm, Storage, FRAME_48K, OPUS_RATE};

/// Bits a second the encoder aims at; it spends fewer on silence.
const BITRATE: i32 = 24_000;
/// One packet's samples at the recording's rate: 20 ms.
const FRAME: usize = (RECORDING_RATE / 50) as usize;
/// More than a 20 ms packet can hold at any rate libopus allows.
const MAX_PACKET: usize = 1_500;
/// Samples at 48 kHz per sample at the recording's rate.
pub const TO_48K: u64 = OPUS_RATE / RECORDING_RATE as u64;

/// A recording of 16 kHz mono PCM16, encoded and written into WebM as it
/// arrives. `write` the samples, then `finish`.
pub struct OpusRecording<S: Storage> {
    encoder: Encoder,
    webm: LiveWebm<S>,
    /// Samples waiting for a whole packet.
    frame: Vec<i16>,
    /// Samples written so far, those waiting included.
    samples: u64,
    /// The encoder's lookahead, at 48 kHz.
    pre_skip: u64,
}

impl<S: Storage> OpusRecording<S> {
    /// Start the encoder and write the file's head into `out`.
    pub fn new(out: S) -> Result<Self, String> {
        let mut encoder = Encoder::new(SampleRate::Hz16000, Channels::Mono, Application::Voip)
            .map_err(|error| format!("start the encoder: {error}"))?;
        encoder
            .set_bitrate(Bitrate::BitsPerSecond(BITRATE))
            .map_err(|error| format!("set the bitrate: {error}"))?;
        let pre_skip = u64::from(
            encoder
                .lookahead()
                .map_err(|error| format!("read the encoder's lookahead: {error}"))?,
        ) * TO_48K;
        let webm = LiveWebm::new(
            out,
            u16::try_from(pre_skip).map_err(|_| format!("a pre-skip of {pre_skip} samples"))?,
            RECORDING_RATE,
        )
        .map_err(written)?;
        Ok(Self {
            encoder,
            webm,
            frame: Vec::with_capacity(FRAME),
            samples: 0,
            pre_skip,
        })
    }

    /// Encode `samples`, each whole 20 ms as it fills.
    pub fn write(&mut self, samples: &[i16]) -> Result<(), String> {
        let mut rest = samples;
        while !rest.is_empty() {
            let take = (FRAME - self.frame.len()).min(rest.len());
            self.frame.extend_from_slice(&rest[..take]);
            self.samples += take as u64;
            rest = &rest[take..];
            if self.frame.len() == FRAME {
                self.encode_frame()?;
            }
        }
        Ok(())
    }

    /// Samples written so far.
    pub fn samples(&self) -> u64 {
        self.samples
    }

    /// Encode what is left, then silence until every sample has left the
    /// encoder's lookahead, and finish the file. Answers how many samples
    /// play. On an error the file holds every whole second written before,
    /// for `webm::finish_cut_off`.
    pub fn finish(mut self) -> Result<u64, String> {
        let wanted = self.pre_skip + self.samples * TO_48K;
        while !self.frame.is_empty() || self.webm.packets() * FRAME_48K < wanted {
            self.frame.resize(FRAME, 0);
            self.encode_frame()?;
        }
        self.webm.finish(self.samples * TO_48K).map_err(written)?;
        Ok(self.samples)
    }

    fn encode_frame(&mut self) -> Result<(), String> {
        let mut packet = [0u8; MAX_PACKET];
        let length = self
            .encoder
            .encode(&self.frame, &mut packet)
            .map_err(|error| format!("encode the recording: {error}"))?;
        self.webm.push(&packet[..length]).map_err(written)?;
        self.frame.clear();
        Ok(())
    }
}

/// A write the disk refused, said as a failure to write the recording.
fn written(error: std::io::Error) -> String {
    format!("write the recording: {error}")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::webm::{finish_cut_off, CutOff, CLUSTER_PACKETS};
    use std::fs::File;
    use std::path::Path;

    /// `count` samples at 16 kHz of `sound`, a function of time in seconds.
    fn samples(count: usize, sound: impl Fn(f32) -> f32) -> Vec<i16> {
        (0..count)
            .map(|index| (sound(index as f32 / RECORDING_RATE as f32) * 16_000.0) as i16)
            .collect()
    }

    fn tone(count: usize) -> Vec<i16> {
        samples(count, |t| (2.0 * std::f32::consts::PI * 440.0 * t).sin())
    }

    /// A tone under a rising pitch, swelling and fading: no two alignments
    /// of it match, as they do for a steady tone a period apart.
    fn sweep(count: usize) -> Vec<i16> {
        samples(count, |t| {
            let tau = 2.0 * std::f32::consts::PI;
            (t * 3.0).sin().abs()
                * (0.6 * (tau * 440.0 * t).sin() + 0.4 * (tau * 1_234.0 * t * (1.0 + t)).sin())
        })
    }

    /// Record `samples` into a new file at `path`, in pieces of `piece`, as
    /// a microphone hands them over, and finish it.
    fn record(path: &Path, samples: &[i16], piece: usize) -> u64 {
        let mut recording = OpusRecording::new(File::create(path).unwrap()).unwrap();
        for chunk in samples.chunks(piece) {
            recording.write(chunk).unwrap();
        }
        recording.finish().unwrap()
    }

    /// The decoder transcription reads a recording with.
    fn decoded(webm: &[u8]) -> Vec<f32> {
        tauri_plugin_epicenter_transcription::audio::decode_to_pcm16k_mono(webm).unwrap()
    }

    fn as_f32(samples: &[i16]) -> Vec<f32> {
        samples.iter().map(|&s| f32::from(s) / 32_768.0).collect()
    }

    /// How alike `a` and `b` are with `b` moved `lag` samples later, from 1
    /// (the same, louder or softer) down; their ends are left out.
    fn likeness(a: &[f32], b: &[f32], lag: i64) -> f64 {
        let (mut ab, mut aa, mut bb) = (0f64, 0f64, 0f64);
        for index in 1_000..a.len().min(b.len()) - 1_000 {
            let (x, y) = (
                f64::from(a[index]),
                f64::from(b[(index as i64 + lag) as usize]),
            );
            ab += x * y;
            aa += x * x;
            bb += y * y;
        }
        ab / (aa.sqrt() * bb.sqrt())
    }

    /// Where `decoded` lines up best with `original`, within 40 samples.
    fn best_lag(original: &[f32], decoded: &[f32]) -> i64 {
        (-40..=40)
            .max_by(|&a, &b| {
                likeness(original, decoded, a).total_cmp(&likeness(original, decoded, b))
            })
            .unwrap()
    }

    /// Every sample written is decoded, in its place: the pre-skip comes
    /// off the front and the padding off the end.
    #[test]
    fn a_recording_decodes_to_every_sample_written_in_place() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a.webm");
        // Not a whole number of packets, in pieces that are not either.
        let samples = sweep(3 * RECORDING_RATE as usize + 17);
        assert_eq!(record(&path, &samples, 441), samples.len() as u64);
        let decoded = decoded(&std::fs::read(&path).unwrap());
        assert_eq!(decoded.len(), samples.len());
        let original = as_f32(&samples);
        assert_eq!(best_lag(&original, &decoded), 0);
        assert!(likeness(&original, &decoded, 0) > 0.95);
        assert_eq!(
            finish_cut_off(&path).unwrap(),
            CutOff::Finished {
                played: samples.len() as u64 * TO_48K
            }
        );
    }

    #[test]
    fn a_tone_keeps_its_pitch() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a.webm");
        record(&path, &tone(2 * RECORDING_RATE as usize), 160);
        let decoded = decoded(&std::fs::read(&path).unwrap());
        // 440 Hz: as many rising zero crossings a second.
        let rising = decoded[RECORDING_RATE as usize / 2..3 * RECORDING_RATE as usize / 2]
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
            .count();
        assert!((438..=442).contains(&rising), "{rising} Hz");
    }

    #[test]
    fn a_recording_that_holds_nothing_is_a_file_that_plays_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a.webm");
        assert_eq!(record(&path, &[], 1), 0);
        assert!(decoded(&std::fs::read(&path).unwrap()).is_empty());
    }

    /// Cut off at random bytes, a recording is finished from its whole
    /// seconds, decodes to exactly the samples it says it plays, each in
    /// its place, and a second recovery writes nothing.
    #[test]
    fn a_recording_cut_off_at_random_bytes_decodes_exactly_once_recovered() {
        let directory = tempfile::tempdir().unwrap();
        let samples = sweep(6 * RECORDING_RATE as usize);
        let original = as_f32(&samples);
        let whole = directory.path().join("whole.webm");
        let mut recording = OpusRecording::new(File::create(&whole).unwrap()).unwrap();
        recording.write(&samples).unwrap();
        // Dropped unfinished: the file as a crash leaves it.
        drop(recording);
        let bytes = std::fs::read(&whole).unwrap();
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        for round in 0..16 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let cut = (seed % bytes.len() as u64) as usize;
            let path = directory.path().join(format!("{round}.webm"));
            std::fs::write(&path, &bytes[..cut]).unwrap();
            let played = match finish_cut_off(&path).unwrap() {
                CutOff::Recovered { played } => played,
                CutOff::Empty => {
                    assert_eq!(std::fs::read(&path).unwrap(), &bytes[..cut]);
                    continue;
                }
                finished => panic!("cut at {cut}: {finished:?}"),
            };
            let recovered = std::fs::read(&path).unwrap();
            let decoded = decoded(&recovered);
            assert_eq!(decoded.len() as u64 * TO_48K, played, "cut at {cut}");
            if decoded.len() > 3_000 {
                assert_eq!(best_lag(&original, &decoded), 0, "cut at {cut}");
            }
            assert_eq!(finish_cut_off(&path).unwrap(), CutOff::Finished { played });
            assert_eq!(std::fs::read(&path).unwrap(), recovered);
        }
    }

    /// A disk that fills mid-recording ends it with a clear error, keeps
    /// every whole second before, and those decode exactly once finished.
    #[test]
    fn a_full_disk_ends_a_recording_with_what_was_written() {
        use crate::webm::tests::FullDisk;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a.webm");
        let mut recording = OpusRecording::new(FullDisk {
            file: File::create(&path).unwrap(),
            room: 9_000,
        })
        .unwrap();
        let samples = sweep(10 * RECORDING_RATE as usize);
        let error = samples
            .chunks(160)
            .find_map(|chunk| recording.write(chunk).err())
            .expect("the disk filled");
        assert!(
            error.starts_with("write the recording: No space left on device"),
            "{error}"
        );
        drop(recording);
        let CutOff::Recovered { played } = finish_cut_off(&path).unwrap() else {
            panic!("expected the whole seconds to be finished");
        };
        let decoded = decoded(&std::fs::read(&path).unwrap());
        assert_eq!(decoded.len() as u64 * TO_48K, played);
        assert!(played > OPUS_RATE, "{played}");
        assert_eq!(best_lag(&as_f32(&samples), &decoded), 0);
    }

    /// What the kill test's child runs: record a sweep of the samples the
    /// parent names into the file it names, say how many were written, and
    /// wait to be killed with the last second held. Does nothing unless a
    /// parent named a file.
    #[test]
    #[ignore = "run by the kill test, in a process of its own"]
    fn records_until_killed() {
        let Some(path) = std::env::var_os("RECORDER_KILL_TEST_FILE") else {
            return;
        };
        let fed: usize = std::env::var("RECORDER_KILL_TEST_SAMPLES")
            .unwrap()
            .parse()
            .unwrap();
        let mut recording = OpusRecording::new(File::create(path).unwrap()).unwrap();
        for chunk in sweep(fed).chunks(FRAME) {
            recording.write(chunk).unwrap();
        }
        println!("fed {}", recording.samples());
        loop {
            std::thread::park();
        }
    }

    /// A process killed mid-recording (SIGKILL: nothing of it runs after)
    /// loses at most the second it held and the encoder's lookahead. Its
    /// file is finished from the whole seconds on the disk, which decode
    /// exactly, in place.
    #[cfg(unix)]
    #[test]
    fn a_recording_killed_mid_way_keeps_all_but_its_last_second() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        let directory = tempfile::tempdir().unwrap();
        let pre_skip = OpusRecording::new(std::io::Cursor::new(Vec::new()))
            .unwrap()
            .pre_skip;
        let lookahead = (pre_skip / TO_48K) as usize;
        let mut most = 0;
        for (round, seconds) in [0.7f64, 1.3, 2.02, 4.98, 7.5].into_iter().enumerate() {
            let path = directory.path().join(format!("{round}.webm"));
            let fed = (seconds * f64::from(RECORDING_RATE)) as usize / FRAME * FRAME;
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "opus::tests::records_until_killed",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("RECORDER_KILL_TEST_FILE", &path)
                .env("RECORDER_KILL_TEST_SAMPLES", fed.to_string())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            // libtest writes the test's name on the same line first.
            let stdout = child.stdout.take().unwrap();
            let (heard, hearing) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let said = std::io::BufReader::new(stdout)
                    .lines()
                    .map_while(Result::ok)
                    .find_map(|line| line.rsplit_once("fed ").map(|(_, fed)| fed.to_string()));
                let _ = heard.send(said);
            });
            let said = hearing
                .recv_timeout(std::time::Duration::from_secs(60))
                .ok()
                .flatten();
            child.kill().unwrap();
            child.wait().unwrap();
            assert_eq!(said, Some(fed.to_string()), "{seconds} s");

            // Every packet written before the held second, less the
            // encoder's delay.
            let packets = fed / FRAME;
            let on_disk = (packets - 1) / CLUSTER_PACKETS * CLUSTER_PACKETS;
            let kept = (on_disk * FRAME).saturating_sub(lookahead);
            let found = finish_cut_off(&path).unwrap();
            let lost = fed - kept;
            most = most.max(lost);
            assert!(
                lost <= CLUSTER_PACKETS * FRAME + lookahead,
                "{seconds} s: lost {lost} samples"
            );
            if kept == 0 {
                assert_eq!(found, CutOff::Empty, "{seconds} s");
                continue;
            }
            assert_eq!(
                found,
                CutOff::Recovered {
                    played: kept as u64 * TO_48K
                },
                "{seconds} s"
            );
            let decoded = decoded(&std::fs::read(&path).unwrap());
            assert_eq!(decoded.len(), kept, "{seconds} s");
            assert_eq!(best_lag(&as_f32(&sweep(fed)), &decoded), 0, "{seconds} s");
        }
        eprintln!(
            "KILLED_MOST_LOST_MS {:.1}",
            most as f64 * 1_000.0 / f64::from(RECORDING_RATE)
        );
    }

    /// An hour streams through: the bytes it takes, and how long Stop takes
    /// once it has. `RECORDER_MEASURE_WAV` names a 16 kHz mono PCM16 WAV to
    /// record instead of a synthetic sweep. Run it in release with
    /// `--ignored --nocapture`.
    #[test]
    #[ignore = "records an hour of audio; run with --release --ignored to measure"]
    fn an_hour_records_live() {
        let samples: Vec<i16> = match std::env::var_os("RECORDER_MEASURE_WAV") {
            Some(path) => {
                let bytes = std::fs::read(path).unwrap();
                let data = bytes
                    .windows(4)
                    .position(|window| window == b"data")
                    .unwrap()
                    + 8;
                bytes[data..]
                    .chunks_exact(2)
                    .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
                    .collect()
            }
            None => sweep(RECORDING_RATE as usize * 60).repeat(60),
        };
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hour.webm");
        let mut recording = OpusRecording::new(File::create(&path).unwrap()).unwrap();
        let started = std::time::Instant::now();
        for chunk in samples.chunks(480) {
            recording.write(chunk).unwrap();
        }
        let recorded = started.elapsed();
        let stopping = std::time::Instant::now();
        let written = recording.finish().unwrap();
        let stop = stopping.elapsed();
        let bytes = std::fs::metadata(&path).unwrap().len();
        let seconds = written as f64 / f64::from(RECORDING_RATE);
        eprintln!(
            "RECORDED_LIVE seconds={seconds:.3} bytes={bytes} bytes_per_hour={:.0} encode_s_per_audio_minute={:.4} stop_ms={:.2}",
            bytes as f64 * 3_600.0 / seconds,
            recorded.as_secs_f64() / (seconds / 60.0),
            stop.as_secs_f64() * 1_000.0,
        );
        assert_eq!(written, samples.len() as u64);
        assert_eq!(
            decoded(&std::fs::read(&path).unwrap()).len() as u64,
            written
        );
    }
}
