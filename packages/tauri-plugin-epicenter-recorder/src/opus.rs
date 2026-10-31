//! Encoding a stopped recording's WAV to Opus, kept in WebM (`webm.rs`).
//!
//! Voice at 24 kbps, variable rate, in 20 ms packets: about 10.5 MB an
//! hour of speech against the WAV's 115 MB, and the same words to a
//! transcriber. The WAV is read 20 ms at a time and every packet is written
//! as it is made, so an hour costs the memory a second does. libopus is the
//! copy `audiopus_sys` bundles, built from source (`.cargo/config.toml`), not
//! whatever a package manager installed, and it encodes the same WAV to the
//! same bytes every time, which recovery relies on to tell a recording it
//! already placed.
//!
//! Opus delays what it encodes by its lookahead, which the file states as
//! the pre-skip a decoder drops, and its last packet is padded to a whole
//! 20 ms, which the file trims. What plays is the WAV's samples exactly.

use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

use audiopus::coder::Encoder;
use audiopus::{Application, Bitrate, Channels, SampleRate};
use hound::{SampleFormat, WavReader};

use crate::recorder::RECORDING_RATE;
use crate::webm::{OpusWebm, FRAME_48K, OPUS_RATE};

/// Bits a second the encoder aims at; it spends fewer on silence.
const BITRATE: i32 = 24_000;
/// One packet's samples at the recording's rate: 20 ms.
const FRAME: usize = (RECORDING_RATE / 50) as usize;
/// More than a 20 ms packet can hold at any rate libopus allows.
const MAX_PACKET: usize = 1_500;

/// Encode the 16 kHz mono PCM16 WAV at `wav` into `out` as Opus in WebM, and
/// flush it to the disk. Answers how many samples it holds; a WAV in any
/// other format is refused, and so is anything the encoder or the disk
/// refuses. `out` is left as far as it got.
pub fn encode(wav: &Path, out: File) -> Result<u64, String> {
    let reader = WavReader::open(wav).map_err(|error| format!("read the recording: {error}"))?;
    let spec = reader.spec();
    if (
        spec.channels,
        spec.sample_rate,
        spec.bits_per_sample,
        spec.sample_format,
    ) != (1, RECORDING_RATE, 16, SampleFormat::Int)
    {
        return Err(format!(
            "the recording is {} channels of {}-bit audio at {} Hz, not mono 16-bit at {RECORDING_RATE} Hz",
            spec.channels, spec.bits_per_sample, spec.sample_rate
        ));
    }
    let mut encoder = Encoder::new(SampleRate::Hz16000, Channels::Mono, Application::Voip)
        .map_err(|error| format!("start the encoder: {error}"))?;
    encoder
        .set_bitrate(Bitrate::BitsPerSecond(BITRATE))
        .map_err(|error| format!("set the bitrate: {error}"))?;
    let to_48k = OPUS_RATE / u64::from(RECORDING_RATE);
    let pre_skip = u64::from(
        encoder
            .lookahead()
            .map_err(|error| format!("read the encoder's lookahead: {error}"))?,
    ) * to_48k;
    let written = |error: std::io::Error| format!("write the encoded recording: {error}");
    let mut webm = OpusWebm::new(
        BufWriter::new(out),
        u16::try_from(pre_skip).map_err(|_| format!("a pre-skip of {pre_skip} samples"))?,
        RECORDING_RATE,
    )
    .map_err(written)?;

    let mut samples = reader.into_samples::<i16>();
    let mut frame = [0i16; FRAME];
    let mut packet = [0u8; MAX_PACKET];
    let mut read = 0u64;
    let mut packets = 0u64;
    let mut ended = false;
    // Past the WAV's end, silence until every sample has left the
    // encoder's lookahead.
    while !ended || packets * FRAME_48K < pre_skip + read * to_48k {
        let mut filled = 0;
        while !ended && filled < FRAME {
            match samples.next() {
                Some(sample) => {
                    frame[filled] =
                        sample.map_err(|error| format!("read the recording: {error}"))?;
                    filled += 1;
                }
                None => ended = true,
            }
        }
        frame[filled..].fill(0);
        read += filled as u64;
        if ended && filled == 0 && packets * FRAME_48K >= pre_skip + read * to_48k {
            break;
        }
        let length = encoder
            .encode(&frame, &mut packet)
            .map_err(|error| format!("encode the recording: {error}"))?;
        webm.push(&packet[..length]).map_err(written)?;
        packets += 1;
    }
    let out = webm.finish(read * to_48k).map_err(written)?;
    let file = out
        .into_inner()
        .map_err(|error| written(error.into_error()))?;
    file.sync_all().map_err(written)?;
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{WavSpec, WavWriter};

    fn spec(sample_rate: u32) -> WavSpec {
        WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        }
    }

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

    fn write_wav(path: &Path, samples: &[i16]) {
        let mut writer = WavWriter::create(path, spec(RECORDING_RATE)).unwrap();
        for &sample in samples {
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    /// Encode `samples` and answer the file's bytes.
    fn encoded(samples: &[i16]) -> Vec<u8> {
        let directory = tempfile::tempdir().unwrap();
        let wav = directory.path().join("a.wav");
        let webm = directory.path().join("a.webm");
        write_wav(&wav, samples);
        let read = encode(&wav, File::create(&webm).unwrap()).unwrap();
        assert_eq!(read, samples.len() as u64);
        std::fs::read(webm).unwrap()
    }

    /// The decoder transcription reads a recording with.
    fn decoded(webm: &[u8]) -> Vec<f32> {
        tauri_plugin_epicenter_transcription::audio::decode_to_pcm16k_mono(webm).unwrap()
    }

    /// How alike `a` and `b` are with `b` moved `lag` samples later, from 1
    /// (the same, louder or softer) down; their ends are left out.
    fn likeness(a: &[f32], b: &[f32], lag: i64) -> f64 {
        let (mut ab, mut aa, mut bb) = (0f64, 0f64, 0f64);
        for index in 1_000..a.len() - 1_000 {
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

    /// Every sample encoded is decoded, in its place: the pre-skip comes off
    /// the front and the padding off the end.
    #[test]
    fn a_recording_decodes_to_every_sample_it_was_encoded_from_in_place() {
        // Not a whole number of packets, so the last one is padded.
        let samples = sweep(3 * RECORDING_RATE as usize + 17);
        let original: Vec<f32> = samples.iter().map(|&s| f32::from(s) / 32_768.0).collect();
        let decoded = decoded(&encoded(&samples));
        assert_eq!(decoded.len(), samples.len());

        let best = (-40..=40)
            .max_by(|&a, &b| {
                likeness(&original, &decoded, a).total_cmp(&likeness(&original, &decoded, b))
            })
            .unwrap();
        assert_eq!(best, 0, "decoded {best} samples late");
        assert!(likeness(&original, &decoded, 0) > 0.95);
    }

    #[test]
    fn a_tone_keeps_its_pitch() {
        let decoded = decoded(&encoded(&tone(2 * RECORDING_RATE as usize)));
        // 440 Hz: as many rising zero crossings a second.
        let rising = decoded[RECORDING_RATE as usize / 2..3 * RECORDING_RATE as usize / 2]
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
            .count();
        assert!((438..=442).contains(&rising), "{rising} Hz");
    }

    /// Recovery tells a recording already placed by its bytes.
    #[test]
    fn the_same_wav_encodes_to_the_same_bytes() {
        let samples = tone(RECORDING_RATE as usize * 2);
        assert_eq!(encoded(&samples), encoded(&samples));
    }

    #[test]
    fn a_recording_that_holds_nothing_is_a_file_that_plays_nothing() {
        assert!(decoded(&encoded(&[])).is_empty());
    }

    #[test]
    fn a_wav_in_another_format_is_refused() {
        let directory = tempfile::tempdir().unwrap();
        let wav = directory.path().join("a.wav");
        let mut writer = WavWriter::create(&wav, spec(48_000)).unwrap();
        writer.write_sample(0i16).unwrap();
        writer.finalize().unwrap();
        let refused = encode(&wav, File::create(directory.path().join("a.webm")).unwrap());
        assert!(refused.unwrap_err().contains("48000 Hz"));
        std::fs::write(&wav, b"not audio").unwrap();
        assert!(encode(&wav, File::create(directory.path().join("b.webm")).unwrap()).is_err());
    }

    /// An hour streams through: the WAV is read and the file written 20 ms
    /// at a time. Prints the sizes and how long it took; run it under
    /// `/usr/bin/time -l` for the most memory it held.
    #[test]
    #[ignore = "encodes an hour of audio; run with --release --ignored to measure"]
    fn an_hour_streams_through_the_encoder() {
        let directory = tempfile::tempdir().unwrap();
        let wav = directory.path().join("hour.wav");
        let mut writer = WavWriter::create(&wav, spec(RECORDING_RATE)).unwrap();
        let second = tone(RECORDING_RATE as usize);
        for _ in 0..3_600 {
            for &sample in &second {
                writer.write_sample(sample).unwrap();
            }
        }
        writer.finalize().unwrap();
        let webm = directory.path().join("hour.webm");
        let started = std::time::Instant::now();
        let read = encode(&wav, File::create(&webm).unwrap()).unwrap();
        let elapsed = started.elapsed();
        let bytes = std::fs::metadata(&webm).unwrap().len();
        eprintln!(
            "ENCODED_HOUR samples={read} wav_bytes={} webm_bytes={bytes} seconds={:.2} seconds_per_minute={:.4}",
            std::fs::metadata(&wav).unwrap().len(),
            elapsed.as_secs_f64(),
            elapsed.as_secs_f64() / 60.0,
        );
        assert_eq!(read, 3_600 * u64::from(RECORDING_RATE));
    }
}
