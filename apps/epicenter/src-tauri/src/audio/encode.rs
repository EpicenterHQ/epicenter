//! Compress a WAV payload into an OGG/Opus blob suitable for cloud
//! transcription upload.
//!
//! libopus runs at one of {8, 12, 16, 24, 48} kHz; we always feed it 48 kHz
//! mono because that's the rate the spec's compression target (24 kbps VBR
//! voice) is tuned for. Output is wrapped in an OGG container with the
//! mandatory OpusHead + OpusTags pages followed by audio packets in 20 ms
//! frames. The result is the on-disk equivalent of `opusenc --bitrate 24
//! recording.wav`, which every cloud Whisper-compatible API accepts.

use std::io::Cursor;

use audiopus::{
    coder::Encoder as OpusEncoder, Application as OpusApplication, Bitrate as OpusBitrate,
    Channels as OpusChannels, SampleRate as OpusSampleRate, Signal as OpusSignal,
};
use log::debug;
use ogg::{PacketWriteEndInfo, PacketWriter};

use super::error::AudioError;
use super::resample::resample_mono;

/// Sample rate libopus encodes at internally. We always resample to this
/// rather than passing the recorder's native rate, because the bitrate /
/// frame-size constants below assume 48 kHz.
const ENCODE_RATE: u32 = 48_000;

/// Frame size at the encode rate. 20 ms is the WebRTC voice default and the
/// libopus example tooling default; smaller frames raise overhead, larger
/// frames raise latency without helping bitrate.
const FRAME_MS: u32 = 20;
const FRAME_SAMPLES: usize = (ENCODE_RATE / 1000 * FRAME_MS) as usize; // 960

/// VBR bitrate the spec selected for voice transcription. Opus at 24 kbps
/// is transparent for speech and matches the WebRTC voice profile. Hardcoded
/// for now; expose as a parameter once a user-facing knob earns it.
const BITRATE_BPS: i32 = 24_000;

/// libopus encoder output is bounded; 4000 bytes per frame is the worst
/// case documented in `opus_encode`'s manpage.
const MAX_PACKET_BYTES: usize = 4000;

/// Serial number used for the single Opus logical stream in the OGG file.
/// A constant is fine because we only ever write one stream per blob.
const OGG_SERIAL: u32 = 0x57_48_53_50; // "WHSP"

/// Encode a mono f32 PCM buffer to an OGG/Opus blob.
///
/// This is the canonical fast path for cloud uploads: the recorder
/// consumer worker (and `decode_to_pcm16k_mono`) always produce mono
/// 16 kHz f32, so we resample to 48 kHz (libopus's internal rate) and
/// encode straight into the OGG container. No WAV synthesis, no
/// Symphonia round-trip, no detour.
pub fn encode_pcm_to_opus_ogg(samples: Vec<f32>, source_rate: u32) -> Result<Vec<u8>, AudioError> {
    debug!(
        "[Audio Encode] encoding {} mono PCM samples @ {} Hz",
        samples.len(),
        source_rate,
    );

    let pcm_48k = resample_mono(samples, source_rate, ENCODE_RATE)?;
    debug!(
        "[Audio Encode] resampled to {} Hz: {} samples",
        ENCODE_RATE,
        pcm_48k.len()
    );

    let (encoder, lookahead) = build_encoder()?;

    let mut out = Cursor::new(Vec::<u8>::with_capacity(pcm_48k.len() / 8));
    let mut packet_writer = PacketWriter::new(&mut out);

    write_opus_head(&mut packet_writer, lookahead, source_rate)?;
    write_opus_tags(&mut packet_writer)?;
    encode_audio_pages(&mut packet_writer, &encoder, &pcm_48k, lookahead)?;

    drop(packet_writer);
    Ok(out.into_inner())
}

/// Construct a libopus encoder configured for voice transcription.
///
/// Returns the encoder together with its lookahead (in 48 kHz samples), the
/// number of samples the decoder will need to skip off the front of the
/// reconstructed stream.
fn build_encoder() -> Result<(OpusEncoder, u32), AudioError> {
    let mut encoder = OpusEncoder::new(
        OpusSampleRate::Hz48000,
        OpusChannels::Mono,
        OpusApplication::Voip,
    )
    .map_err(|e| AudioError::encode(format!("libopus encoder init failed: {e}")))?;

    encoder
        .set_bitrate(OpusBitrate::BitsPerSecond(BITRATE_BPS))
        .map_err(|e| AudioError::encode(format!("set_bitrate failed: {e}")))?;
    encoder
        .set_vbr(true)
        .map_err(|e| AudioError::encode(format!("set_vbr failed: {e}")))?;
    encoder
        .set_signal(OpusSignal::Voice)
        .map_err(|e| AudioError::encode(format!("set_signal failed: {e}")))?;

    let lookahead = encoder
        .lookahead()
        .map_err(|e| AudioError::encode(format!("lookahead query failed: {e}")))?;

    Ok((encoder, lookahead))
}

/// Write the OpusHead identification packet (page 0, RFC 7845 §5.1).
fn write_opus_head<W: std::io::Write>(
    writer: &mut PacketWriter<'_, W>,
    pre_skip_samples: u32,
    input_rate: u32,
) -> Result<(), AudioError> {
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // Version
    head.push(1); // Channel count
    head.extend_from_slice(&(pre_skip_samples as u16).to_le_bytes());
    head.extend_from_slice(&input_rate.to_le_bytes()); // Informational
    head.extend_from_slice(&0i16.to_le_bytes()); // Output gain
    head.push(0); // Channel mapping family = 0 (mono/stereo)

    writer
        .write_packet(head, OGG_SERIAL, PacketWriteEndInfo::EndPage, 0)
        .map_err(|e| AudioError::encode(format!("ogg OpusHead write failed: {e}")))
}

/// Write the OpusTags comment packet (page 1, RFC 7845 §5.2). The minimum
/// valid payload is the magic + vendor string + zero user-comment entries.
fn write_opus_tags<W: std::io::Write>(writer: &mut PacketWriter<'_, W>) -> Result<(), AudioError> {
    let vendor = b"epicenter";
    let mut tags = Vec::with_capacity(8 + 4 + vendor.len() + 4);
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0u32.to_le_bytes()); // User comment list length

    writer
        .write_packet(tags, OGG_SERIAL, PacketWriteEndInfo::EndPage, 0)
        .map_err(|e| AudioError::encode(format!("ogg OpusTags write failed: {e}")))
}

/// Encode the PCM stream as a sequence of 20 ms Opus packets and write each
/// into the OGG container. The last packet is zero-padded to a full frame
/// boundary and marked end-of-stream.
///
/// Granule positions follow RFC 7845 §4: each packet's absgp is the running
/// total of 48 kHz samples *including* the encoder's lookahead padding, so
/// the decoder can trim the pre-skip exactly.
fn encode_audio_pages<W: std::io::Write>(
    writer: &mut PacketWriter<'_, W>,
    encoder: &OpusEncoder,
    pcm_48k: &[f32],
    lookahead: u32,
) -> Result<(), AudioError> {
    let mut packet_buf = vec![0u8; MAX_PACKET_BYTES];
    let mut frame_buf = vec![0f32; FRAME_SAMPLES];

    // Pre-skip lookahead samples per RFC 7845 §4.2: prepend silence so the
    // decoder's first valid output sample lines up with the original PCM.
    let lookahead = lookahead as usize;
    let padded_len = pcm_48k.len() + lookahead;
    let total_frames = padded_len.div_ceil(FRAME_SAMPLES);
    let mut absgp: u64 = 0;

    for frame_idx in 0..total_frames {
        let frame_start = frame_idx * FRAME_SAMPLES;
        let is_last = frame_idx + 1 == total_frames;

        for (i, slot) in frame_buf.iter_mut().enumerate() {
            let padded_idx = frame_start + i;
            *slot = if padded_idx < lookahead {
                0.0
            } else {
                let src_idx = padded_idx - lookahead;
                pcm_48k.get(src_idx).copied().unwrap_or(0.0)
            };
        }

        let n_bytes = encoder
            .encode_float(&frame_buf, &mut packet_buf)
            .map_err(|e| AudioError::encode(format!("opus encode_float failed: {e}")))?;

        // The granule position for an Opus page is the index of the last
        // sample completable at that page, expressed in 48 kHz units. We
        // bump by FRAME_SAMPLES per packet; the final packet's absgp may
        // overshoot the true end-of-audio by up to one frame, which the
        // decoder discards correctly using the trailing absgp + pre-skip.
        absgp += FRAME_SAMPLES as u64;
        let end_info = if is_last {
            PacketWriteEndInfo::EndStream
        } else {
            PacketWriteEndInfo::NormalPacket
        };

        writer
            .write_packet(packet_buf[..n_bytes].to_vec(), OGG_SERIAL, end_info, absgp)
            .map_err(|e| AudioError::encode(format!("ogg audio packet write failed: {e}")))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::decode::decode_to_pcm16k_mono;
    use hound::{SampleFormat as HoundSampleFormat, WavSpec, WavWriter};

    /// Synthesize a `secs`-long, single-channel WAV at `sample_rate`,
    /// containing a sine wave at `freq_hz`. Matches the shape of the
    /// fixtures used in decode.rs's tests.
    fn make_sine_wav(secs: f32, sample_rate: u32, freq_hz: f32) -> Vec<u8> {
        let spec = WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: HoundSampleFormat::Int,
        };
        let total = (secs * sample_rate as f32) as usize;
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = WavWriter::new(&mut cursor, spec).unwrap();
            for i in 0..total {
                let t = i as f32 / sample_rate as f32;
                let v = (2.0 * std::f32::consts::PI * freq_hz * t).sin() * 0.5;
                writer.write_sample((v * 32767.0) as i16).unwrap();
            }
            writer.finalize().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn encoded_blob_starts_with_ogg_magic_and_opushead() {
        let secs = 0.5f32;
        let rate = 16_000u32;
        let samples: Vec<f32> = (0..(secs * rate as f32) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / rate as f32).sin() * 0.5)
            .collect();
        let ogg_bytes = encode_pcm_to_opus_ogg(samples, rate).expect("encode");

        // OGG pages start with "OggS"; the first audio data after the page
        // header is the OpusHead identification packet.
        assert_eq!(&ogg_bytes[..4], b"OggS", "missing OGG capture pattern");
        let opushead_idx = ogg_bytes
            .windows(8)
            .position(|w| w == b"OpusHead")
            .expect("OpusHead packet not found");
        assert!(opushead_idx < 64, "OpusHead should land in the first page");
    }

    #[test]
    fn roundtrip_5s_sine_preserves_duration_and_frequency() {
        // 5 s @ 16 kHz, 440 Hz sine. Roundtrip: WAV (CPAL blob shape) ->
        // decode_to_pcm16k_mono -> encode_pcm_to_opus_ogg -> decoder. This
        // mirrors what `encode_recording_for_upload` does at runtime.
        let secs = 5.0f32;
        let in_rate = 16_000u32;
        let target_rate = 16_000u32;
        let freq_hz = 440.0f32;
        let wav = make_sine_wav(secs, in_rate, freq_hz);

        let pcm = decode_to_pcm16k_mono(&wav).expect("decode wav");
        let ogg_bytes = encode_pcm_to_opus_ogg(pcm, target_rate).expect("encode");
        let decoded = decode_to_pcm16k_mono(&ogg_bytes).expect("decode");

        // Duration: ±50 ms tolerance per the spec's success criterion.
        let expected_samples = (secs * target_rate as f32) as i64;
        let actual_samples = decoded.len() as i64;
        let delta_samples = (actual_samples - expected_samples).abs();
        let delta_ms = delta_samples as f32 * 1000.0 / target_rate as f32;
        assert!(
            delta_ms <= 50.0,
            "duration drift {delta_ms} ms exceeds 50 ms tolerance \
             (expected {expected_samples} samples, got {actual_samples})",
        );

        // Frequency: peak the magnitude of a Goertzel-style direct DFT at
        // bins {freq_hz - 50, freq_hz, freq_hz + 50}; the middle bin must
        // dominate. Goertzel beats a full FFT here because we only need
        // three bins and don't want to pull in a dep.
        let bin_size_hz = 10.0;
        let mut peak_bin_hz = 0.0;
        let mut peak_mag = 0.0;
        let probe_start = (freq_hz - 100.0).max(50.0);
        let probe_end = freq_hz + 100.0;
        let mut probe_hz = probe_start;
        while probe_hz <= probe_end {
            let mag = goertzel_magnitude(&decoded, target_rate as f32, probe_hz);
            if mag > peak_mag {
                peak_mag = mag;
                peak_bin_hz = probe_hz;
            }
            probe_hz += bin_size_hz;
        }
        assert!(
            (peak_bin_hz - freq_hz).abs() <= 10.0,
            "peak frequency {peak_bin_hz} Hz drifted more than 10 Hz from {freq_hz} Hz",
        );
    }

    /// Goertzel single-bin DFT magnitude. Less allocy than running rustfft
    /// for one probe frequency. Returns ‖X(f)‖, not normalized.
    fn goertzel_magnitude(samples: &[f32], sample_rate: f32, freq_hz: f32) -> f32 {
        let omega = 2.0 * std::f32::consts::PI * freq_hz / sample_rate;
        let coeff = 2.0 * omega.cos();
        let mut s_prev = 0.0;
        let mut s_prev2 = 0.0;
        for &x in samples {
            let s = x + coeff * s_prev - s_prev2;
            s_prev2 = s_prev;
            s_prev = s;
        }
        (s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2).sqrt()
    }
}
