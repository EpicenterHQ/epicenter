//! Single canonical decode path: opaque audio bytes → 16 kHz mono f32 PCM.
//!
//! Symphonia handles container demux and decode for everything except Opus.
//! Opus packets (inside WebM, OGG, or MP4) are extracted by Symphonia as a
//! demuxer and decoded by libopus through the `audiopus` crate, because
//! Symphonia's own Opus decoder is incomplete as of 0.5.5.

use std::io::Cursor;

use audiopus::{
    coder::Decoder as OpusDecoder, packet::Packet as OpusPacket, Channels as OpusChannels,
    SampleRate as OpusSampleRate,
};
use log::{debug, warn};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL, CODEC_TYPE_OPUS},
    errors::Error as SymphoniaError,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

use super::error::AudioError;
use super::resample::resample_mono;

/// Target sample rate for local GGUF transcription, which consumes 16 kHz mono.
const TARGET_RATE: u32 = 16_000;

/// libopus runs at 48 kHz internally; any Opus packet from any container
/// produces output at this rate.
const OPUS_RATE: u32 = 48_000;

/// Decode arbitrary audio bytes into 16 kHz mono interleaved f32 PCM.
///
/// Returns an empty `Vec` when the input decodes to zero audible samples
/// (very short clips, all-silence trimmed to nothing); the caller is
/// expected to short-circuit to an empty transcript in that case.
pub fn decode_to_pcm16k_mono(bytes: &[u8]) -> Result<Vec<f32>, AudioError> {
    debug!("[Audio Decode] starting decode for {} bytes", bytes.len());

    if bytes.is_empty() {
        return Ok(Vec::new());
    }

    // Symphonia's `MediaSource` trait requires `'static`, so the bytes are
    // copied into an owned cursor here rather than borrowed.
    let cursor = Cursor::new(bytes.to_vec());
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

    let probed = symphonia::default::get_probe()
        .format(
            &Hint::new(),
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| AudioError::decode(format!("container probe failed: {e}")))?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| AudioError::unsupported("no audio track in container".to_string()))?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let (samples, source_rate, channel_count) = if codec_params.codec == CODEC_TYPE_OPUS {
        decode_via_libopus(&mut *format, track_id, &codec_params)?
    } else {
        decode_via_symphonia(&mut *format, track_id, &codec_params)?
    };
    debug!(
        "[Audio Decode] decoded {} samples @ {} Hz x {} channels",
        samples.len(),
        source_rate,
        channel_count
    );

    let mono = if channel_count <= 1 {
        samples
    } else {
        let n = channel_count as usize;
        samples
            .chunks_exact(n)
            .map(|chunk| chunk.iter().sum::<f32>() / n as f32)
            .collect()
    };
    debug!("[Audio Decode] downmix to mono: {} samples", mono.len());

    let resampled = resample_mono(mono, source_rate, TARGET_RATE)?;
    debug!(
        "[Audio Decode] resampled to {} Hz: {} samples",
        TARGET_RATE,
        resampled.len()
    );

    Ok(resampled)
}

/// Decode any non-Opus codec via Symphonia's registered decoder.
///
/// Sample rate and channel count are discovered from the first decoded
/// packet's spec rather than `CodecParameters`, because some codecs (AAC
/// in particular) leave those fields unpopulated until the first frame
/// is decoded.
fn decode_via_symphonia(
    format: &mut dyn symphonia::core::formats::FormatReader,
    track_id: u32,
    codec_params: &symphonia::core::codecs::CodecParameters,
) -> Result<(Vec<f32>, u32, u16), AudioError> {
    let mut decoder = symphonia::default::get_codecs()
        .make(codec_params, &DecoderOptions::default())
        .map_err(|e| AudioError::decode(format!("decoder init failed: {e}")))?;

    let mut interleaved: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut discovered: Option<(u32, u16)> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // EOF is the normal exit condition; Symphonia signals it as an
            // unexpected EOF on the underlying IO.
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(AudioError::decode(format!("next_packet failed: {e}"))),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                if discovered.is_none() {
                    let chans = spec.channels.count() as u16;
                    if chans == 0 {
                        return Err(AudioError::unsupported(
                            "decoded packet reports zero channels",
                        ));
                    }
                    discovered = Some((spec.rate, chans));
                    let capacity = decoded.capacity() as u64;
                    sample_buf = Some(SampleBuffer::<f32>::new(capacity, spec));
                }
                let buf = sample_buf.as_mut().expect("initialised above");
                buf.copy_interleaved_ref(decoded);
                interleaved.extend_from_slice(buf.samples());
            }
            Err(SymphoniaError::DecodeError(e)) => {
                warn!("[Audio Decode] skipping corrupt packet: {e}");
                continue;
            }
            Err(e) => return Err(AudioError::decode(format!("decode failed: {e}"))),
        }
    }

    let (sample_rate, channel_count) = discovered
        .ok_or_else(|| AudioError::decode("no audio packets decoded from container".to_string()))?;
    Ok((interleaved, sample_rate, channel_count))
}

/// Decode an Opus track by extracting raw packets from the container
/// (Symphonia) and decoding them with libopus (audiopus).
///
/// Unlike `decode_via_symphonia`, this does not skip individual packet
/// decode errors. Container demuxers (OGG, MKV/WebM) validate packets
/// before yielding them, so a libopus decode failure typically signals
/// genuine corruption rather than a recoverable boundary glitch.
fn decode_via_libopus(
    format: &mut dyn symphonia::core::formats::FormatReader,
    track_id: u32,
    codec_params: &symphonia::core::codecs::CodecParameters,
) -> Result<(Vec<f32>, u32, u16), AudioError> {
    // Some container/codec combinations leave `channels` unpopulated on
    // `CodecParameters` (notably Opus inside Matroska/WebM). The OpusHead
    // identification header carries the channel count at byte 9 per
    // RFC 7845 §5.1; Symphonia surfaces that header via `extra_data`.
    let channel_count = codec_params
        .channels
        .map(|c| c.count() as u16)
        .or_else(|| {
            codec_params
                .extra_data
                .as_deref()
                .and_then(|h| h.get(9).copied())
                .map(|c| c as u16)
        })
        .ok_or_else(|| AudioError::unsupported("opus track missing channel layout"))?;

    let opus_channels = match channel_count {
        1 => OpusChannels::Mono,
        2 => OpusChannels::Stereo,
        n => {
            return Err(AudioError::unsupported(format!(
                "opus track with {n} channels is unsupported"
            )))
        }
    };

    let mut decoder = OpusDecoder::new(OpusSampleRate::Hz48000, opus_channels)
        .map_err(|e| AudioError::decode(format!("libopus init failed: {e}")))?;

    // Worst-case Opus frame size: 120 ms @ 48 kHz = 5760 samples per channel.
    let max_frame = 5760usize * channel_count as usize;
    let mut scratch = vec![0f32; max_frame];

    let mut interleaved: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(AudioError::decode(format!("next_packet failed: {e}"))),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let opus_packet = OpusPacket::try_from(packet.data.as_ref())
            .map_err(|e| AudioError::decode(format!("opus packet wrap failed: {e}")))?;

        let out = (&mut scratch[..])
            .try_into()
            .map_err(|e| AudioError::decode(format!("opus output buffer wrap failed: {e}")))?;

        let frames = decoder
            .decode_float(Some(opus_packet), out, false)
            .map_err(|e| AudioError::decode(format!("libopus decode failed: {e}")))?;

        let n_samples = frames * channel_count as usize;
        interleaved.extend_from_slice(&scratch[..n_samples]);
    }

    // Drop the pre-skip frames the encoder padded onto the front, per
    // RFC 7845 §4.2. Symphonia parses this out of OpusHead and exposes it
    // on `CodecParameters::delay`.
    let pre_skip_frames = codec_params.delay.unwrap_or(0) as usize;
    let pre_skip_samples = pre_skip_frames * channel_count as usize;
    if pre_skip_samples > 0 && pre_skip_samples < interleaved.len() {
        interleaved.drain(..pre_skip_samples);
    }

    Ok((interleaved, OPUS_RATE, channel_count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavSpec, WavWriter};
    use std::io::Cursor as IoCursor;

    /// Write a `samples_per_channel`-long, `channels`-channel WAV at
    /// `sample_rate` to memory. Sample values are i16 PCM derived from
    /// the provided f32 input (clamped + scaled).
    fn make_wav(
        samples_per_channel: usize,
        channels: u16,
        sample_rate: u32,
        f: impl Fn(usize, u16) -> f32,
    ) -> Vec<u8> {
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut cursor = IoCursor::new(Vec::new());
        {
            let mut writer = WavWriter::new(&mut cursor, spec).unwrap();
            for i in 0..samples_per_channel {
                for c in 0..channels {
                    let v = f(i, c).clamp(-1.0, 1.0);
                    writer.write_sample((v * 32767.0) as i16).unwrap();
                }
            }
            writer.finalize().unwrap();
        }
        cursor.into_inner()
    }

    fn sine_at(i: usize, freq_hz: f32, sample_rate: u32) -> f32 {
        let t = i as f32 / sample_rate as f32;
        (2.0 * std::f32::consts::PI * freq_hz * t).sin() * 0.5
    }

    #[test]
    fn decodes_16k_mono_wav_with_correct_length() {
        let secs = 1;
        let rate = 16_000;
        let bytes = make_wav(secs * rate as usize, 1, rate, |i, _| {
            sine_at(i, 440.0, rate)
        });

        let samples = decode_to_pcm16k_mono(&bytes).expect("decode");

        // Lossless path: no resample, no downmix. Output length matches input length exactly.
        assert_eq!(samples.len(), secs * rate as usize);
    }

    #[test]
    fn downmixes_and_resamples_48k_stereo_wav_to_16k_mono() {
        let secs = 1;
        let in_rate = 48_000;
        let bytes = make_wav(secs * in_rate as usize, 2, in_rate, |i, c| {
            // Different content per channel exercises the downmix.
            if c == 0 {
                sine_at(i, 440.0, in_rate)
            } else {
                sine_at(i, 880.0, in_rate)
            }
        });

        let samples = decode_to_pcm16k_mono(&bytes).expect("decode");

        let expected = secs * TARGET_RATE as usize;
        // Resampler's fixed-chunk tail trimming gets us within a frame.
        assert!(
            samples.len().abs_diff(expected) <= 1,
            "expected ~{expected} samples, got {}",
            samples.len(),
        );
    }

    #[test]
    fn returns_empty_for_empty_input() {
        let samples = decode_to_pcm16k_mono(&[]).expect("decode");
        assert!(samples.is_empty());
    }

    #[test]
    fn returns_decode_error_for_garbage_input() {
        let garbage = vec![0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE];
        let result = decode_to_pcm16k_mono(&garbage);
        assert!(
            matches!(result, Err(AudioError::DecodeFailed { .. })),
            "expected DecodeFailed, got {result:?}",
        );
    }

    #[test]
    fn decode_then_resample_matches_direct_resample_within_quantization_noise() {
        // Verify the WAV decode + stereo downmix do not perturb samples
        // beyond i16 quantization noise. We compare two paths that both
        // end in the same `resample_mono`:
        //   path A: WAV bytes -> decode_to_pcm16k_mono
        //   path B: analytical mono sine -> resample_mono
        // The legacy hound + rubato Tier 2 pipeline is gone, so this is
        // an internal consistency check (decode+downmix is the identity
        // on equal-channel stereo modulo quantization), not an old-vs-new
        // pipeline comparison.
        let in_rate = 48_000;
        let secs = 1;
        let bytes = make_wav(secs * in_rate as usize, 2, in_rate, |i, _| {
            // Identical L/R channels so the downmix average equals the
            // single-channel sine, making the comparison clean.
            sine_at(i, 220.0, in_rate)
        });

        let new_samples = decode_to_pcm16k_mono(&bytes).expect("decode");

        let mono: Vec<f32> = (0..secs * in_rate as usize)
            .map(|i| sine_at(i, 220.0, in_rate))
            .collect();
        let expected = resample_mono(mono, in_rate, TARGET_RATE).expect("resample");

        let len = new_samples.len().min(expected.len());
        // Ignore the first/last few samples where the resampler's edge
        // ringing on the quantization step amplifies above the noise floor.
        let pad = 32;
        let mut max_diff = 0.0f32;
        for i in pad..(len - pad) {
            let d = (new_samples[i] - expected[i]).abs();
            if d > max_diff {
                max_diff = d;
            }
        }
        // i16 quantization noise floor is ~1/32768 ≈ 3e-5; allow a small
        // multiple for the resampler smearing the quantization.
        assert!(max_diff < 1e-3, "max diff {max_diff} exceeded tolerance");
    }
}
