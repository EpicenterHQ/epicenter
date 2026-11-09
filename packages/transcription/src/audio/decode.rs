//! Single canonical decode path: opaque audio bytes → 16 kHz mono f32 PCM.
//!
//! Symphonia handles container demux and decode for everything except Opus.
//! Opus packets (inside WebM, OGG, or MP4) are extracted by Symphonia as a
//! demuxer and decoded by libopus through the `audiopus` crate, because
//! Symphonia's own Opus decoder is incomplete as of 0.5.5. Symphonia also
//! reads neither a WebM track's pre-skip nor its end trim, so those are read
//! here (`decode_via_libopus`).

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

/// The rate an Opus stream states its pre-skip, granule positions, and
/// padding at, whatever rate it is decoded to (RFC 7845).
const OPUS_RATE: u64 = 48_000;

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
        decode_via_libopus(&mut *format, track_id, &codec_params, bytes)?
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
/// (Symphonia) and decoding them with libopus (audiopus), then trim it to
/// what the file says plays: the encoder's pre-skip off the front (RFC 7845
/// section 4.2), and off the end the padding of its last packet, stated by
/// an Ogg stream's last granule position or a WebM file's last
/// DiscardPadding. `bytes` is the whole file, read for the end.
///
/// libopus decodes straight to the 16 kHz transcription reads, as it can
/// for any stream: the samples a 16 kHz recording was encoded from come
/// back in place, with no resampler's delay, and a 48 kHz stream's high
/// band, which 16 kHz cannot hold, is not decoded at all.
///
/// Unlike `decode_via_symphonia`, this does not skip individual packet
/// decode errors. Container demuxers (OGG, MKV/WebM) validate packets
/// before yielding them, so a libopus decode failure typically signals
/// genuine corruption rather than a recoverable boundary glitch.
fn decode_via_libopus(
    format: &mut dyn symphonia::core::formats::FormatReader,
    track_id: u32,
    codec_params: &symphonia::core::codecs::CodecParameters,
    bytes: &[u8],
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

    let mut decoder = OpusDecoder::new(OpusSampleRate::Hz16000, opus_channels)
        .map_err(|e| AudioError::decode(format!("libopus init failed: {e}")))?;
    // From Opus's 48 kHz counts to samples decoded.
    let per_sample = OPUS_RATE / u64::from(TARGET_RATE);

    // Worst-case Opus frame size: 120 ms @ 16 kHz = 1920 samples per channel.
    let max_frame = 1920usize * channel_count as usize;
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

    let channels = channel_count as usize;
    let decoded = (interleaved.len() / channels) as u64;
    // Symphonia reads the pre-skip out of an Ogg stream's OpusHead into
    // `delay`, and not out of a WebM track's, whose CodecPrivate is the same
    // OpusHead: bytes 10 and 11, little-endian.
    let pre_skip = codec_params
        .delay
        .map(u64::from)
        .or_else(|| {
            let head = codec_params.extra_data.as_deref()?;
            let pre_skip = head.get(10..12)?;
            Some(u64::from(u16::from_le_bytes([pre_skip[0], pre_skip[1]])))
        })
        .map_or(0, |pre_skip| pre_skip / per_sample)
        .min(decoded);
    let played = if bytes.starts_with(b"OggS") {
        ogg_last_granule(bytes).map(|granule| (granule / per_sample).saturating_sub(pre_skip))
    } else {
        webm_last_discard_padding(bytes).map(|nanoseconds| {
            let padding = (nanoseconds * u64::from(TARGET_RATE) + 500_000_000) / 1_000_000_000;
            (decoded - pre_skip).saturating_sub(padding)
        })
    };
    interleaved.drain(..pre_skip as usize * channels);
    if let Some(played) = played {
        interleaved.truncate(played as usize * channels);
    }

    Ok((interleaved, TARGET_RATE, channel_count))
}

/// The granule position of an Ogg file's last page: its last sample, at
/// 48 kHz for Opus, counting the pre-skip. `None` when the bytes do not end
/// in a whole page, or that page ends no packet.
fn ogg_last_granule(bytes: &[u8]) -> Option<u64> {
    // A page: "OggS", version, flags, granule (8 bytes, little-endian),
    // serial, sequence, checksum, then its segment count and lacing values
    // (27 bytes and the table), then the segments.
    let mut at = bytes.len().checked_sub(27)?;
    loop {
        if bytes[at..].starts_with(b"OggS") {
            let segments = usize::from(*bytes.get(at + 26)?);
            let table = bytes.get(at + 27..at + 27 + segments)?;
            let length = 27
                + segments
                + table
                    .iter()
                    .map(|&lacing| usize::from(lacing))
                    .sum::<usize>();
            if at + length == bytes.len() {
                let granule = u64::from_le_bytes(bytes[at + 6..at + 14].try_into().ok()?);
                return (granule != u64::MAX).then_some(granule);
            }
        }
        at = at.checked_sub(1)?;
    }
}

/// The DiscardPadding of a WebM file's last block, in nanoseconds: how much
/// of its last packet's end the encoder padded and a player trims. `None`
/// when the last block has none.
///
/// Walks the elements in order, entering the Segment and each Cluster (whose
/// sizes a live recorder may leave unknown: their children follow either
/// way) and stepping over everything else.
fn webm_last_discard_padding(bytes: &[u8]) -> Option<u64> {
    const SEGMENT: u64 = 0x1853_8067;
    const CLUSTER: u64 = 0x1F43_B675;
    const SIMPLE_BLOCK: u64 = 0xA3;
    const BLOCK_GROUP: u64 = 0xA0;
    const DISCARD_PADDING: u64 = 0x75A2;

    let mut padding = None;
    let mut at = 0;
    while let Some(element) = ebml_element(bytes, at) {
        match element.id {
            SEGMENT | CLUSTER => {
                at = element.body;
                continue;
            }
            SIMPLE_BLOCK => padding = None,
            BLOCK_GROUP => {
                padding = None;
                let mut child_at = element.body;
                while let Some(child) =
                    ebml_element(bytes, child_at).filter(|child| child.end <= element.end)
                {
                    if child.id == DISCARD_PADDING {
                        let value = &bytes[child.body..child.end];
                        if !value.is_empty() && value.len() <= 8 {
                            let sign = if value[0] & 0x80 != 0 { 0xFF } else { 0 };
                            let mut signed = [sign; 8];
                            signed[8 - value.len()..].copy_from_slice(value);
                            padding = u64::try_from(i64::from_be_bytes(signed)).ok();
                        }
                    }
                    child_at = child.end;
                }
            }
            _ => {}
        }
        at = element.end;
    }
    padding
}

/// An EBML element: its ID (marker bits kept), where its body starts, and
/// where it ends.
struct EbmlElement {
    id: u64,
    body: usize,
    end: usize,
}

/// The whole element at `at`, or `None` when there is none there or it runs
/// past the end. An unknown size ends at the end of `bytes`.
fn ebml_element(bytes: &[u8], at: usize) -> Option<EbmlElement> {
    let (id, id_length) = ebml_vint(bytes, at, true)?;
    let (size, size_length) = ebml_vint(bytes, at + id_length, false)?;
    let body = at + id_length + size_length;
    let unknown = size == (1u64 << (7 * size_length)) - 1;
    let end = if unknown {
        bytes.len()
    } else {
        body.checked_add(usize::try_from(size).ok()?)?
    };
    (end <= bytes.len()).then_some(EbmlElement { id, body, end })
}

/// The variable-length integer at `at` and its length, with its length
/// marker kept (an ID) or cleared (a size).
fn ebml_vint(bytes: &[u8], at: usize, keep_marker: bool) -> Option<(u64, usize)> {
    let first = *bytes.get(at)?;
    if first == 0 {
        return None;
    }
    let length = first.leading_zeros() as usize + 1;
    let rest = bytes.get(at + 1..at + length)?;
    let first = if keep_marker {
        first
    } else {
        first & 0xFFu8.checked_shr(length as u32).unwrap_or(0)
    };
    let value = rest.iter().fold(u64::from(first), |value, &byte| {
        (value << 8) | u64::from(byte)
    });
    Some((value, length))
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

    /// Ogg Opus as `opusenc` writes it (RFC 7845): `OpusHead`, `OpusTags`,
    /// 20 ms packets about a second to a page, and the last page's granule
    /// position stating where the stream ends, before its last packet does.
    /// `samples` are at 16 kHz.
    fn ogg_opus(samples: &[i16]) -> Vec<u8> {
        use audiopus::{coder::Encoder, Application};
        use ogg::writing::{PacketWriteEndInfo, PacketWriter};

        let encoder = Encoder::new(
            OpusSampleRate::Hz16000,
            OpusChannels::Mono,
            Application::Voip,
        )
        .unwrap();
        let pre_skip = u64::from(encoder.lookahead().unwrap()) * 3;
        let mut head = b"OpusHead\x01\x01".to_vec();
        head.extend_from_slice(&(pre_skip as u16).to_le_bytes());
        head.extend_from_slice(&16_000u32.to_le_bytes());
        head.extend_from_slice(&[0, 0, 0]);
        let mut tags = b"OpusTags".to_vec();
        tags.extend_from_slice(&[4, 0, 0, 0]);
        tags.extend_from_slice(b"test");
        tags.extend_from_slice(&[0, 0, 0, 0]);

        let mut writer = PacketWriter::new(Vec::new());
        writer
            .write_packet(head, 1, PacketWriteEndInfo::EndPage, 0)
            .unwrap();
        writer
            .write_packet(tags, 1, PacketWriteEndInfo::EndPage, 0)
            .unwrap();
        let end = pre_skip + 3 * samples.len() as u64;
        let mut frames: Vec<[i16; 320]> = samples
            .chunks(320)
            .map(|chunk| {
                let mut frame = [0i16; 320];
                frame[..chunk.len()].copy_from_slice(chunk);
                frame
            })
            .collect();
        while (frames.len() as u64) * 960 < end {
            frames.push([0; 320]);
        }
        let mut packet = [0u8; 1_500];
        for (index, frame) in frames.iter().enumerate() {
            let length = encoder.encode(frame, &mut packet).unwrap();
            let last = index + 1 == frames.len();
            let (info, granule) = if last {
                (PacketWriteEndInfo::EndStream, end)
            } else if (index + 1) % 50 == 0 {
                (PacketWriteEndInfo::EndPage, (index as u64 + 1) * 960)
            } else {
                (PacketWriteEndInfo::NormalPacket, (index as u64 + 1) * 960)
            };
            writer
                .write_packet(packet[..length].to_vec(), 1, info, granule)
                .unwrap();
        }
        writer.into_inner()
    }

    /// The pre-skip comes off the front and the end comes where the last
    /// granule position says, so every sample encoded is decoded, in place.
    #[test]
    fn decodes_ogg_opus_to_exactly_the_samples_encoded() {
        let count = 2 * 16_000 + 123;
        let original: Vec<i16> = (0..count)
            .map(|i| {
                let t = i as f32 / 16_000.0;
                let tau = 2.0 * std::f32::consts::PI;
                ((t * 3.0).sin().abs()
                    * (0.6 * (tau * 440.0 * t).sin() + 0.4 * (tau * 1_234.0 * t * (1.0 + t)).sin())
                    * 16_000.0) as i16
            })
            .collect();

        let decoded = decode_to_pcm16k_mono(&ogg_opus(&original)).expect("decode");
        assert_eq!(decoded.len(), count);

        let likeness = |lag: i64| {
            let (mut ab, mut aa, mut bb) = (0f64, 0f64, 0f64);
            for i in 1_000..count - 1_000 {
                let x = f64::from(original[i]) / 32_768.0;
                let y = f64::from(decoded[(i as i64 + lag) as usize]);
                ab += x * y;
                aa += x * x;
                bb += y * y;
            }
            ab / (aa.sqrt() * bb.sqrt())
        };
        let best = (-40..=40)
            .max_by(|&a, &b| likeness(a).total_cmp(&likeness(b)))
            .unwrap();
        assert_eq!(best, 0, "decoded {best} samples late");
        assert!(likeness(0) > 0.95);
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
