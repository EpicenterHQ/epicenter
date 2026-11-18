//! Integration tests for the audio decoder against real container fixtures.
//!
//! Each fixture is a 2-second 440 Hz mono sine wave encoded into a different
//! container/codec combination. We assert decode succeeds and produces the
//! expected sample count at 16 kHz mono (within a small slack for codec
//! priming, pre-skip, and resampler tail effects).

use tauri_plugin_epicenter_transcription::audio::decode_to_pcm16k_mono;

const FIXTURE_SECONDS: usize = 2;
const TARGET_RATE: usize = 16_000;
const EXPECTED_SAMPLES: usize = FIXTURE_SECONDS * TARGET_RATE; // 32_000

/// Tolerance for codec priming, pre-skip, and resampler tail effects.
/// MP3's encoder delay is ~576 samples per layer-III frame at the source
/// rate (which becomes ~190 samples at 16 kHz after resampling), AAC adds
/// 2112 samples of priming, and Opus pre-skip is typically 312 samples
/// at 48 kHz (~104 at 16 kHz). 1000 samples = 62.5 ms at 16 kHz, which
/// generously covers any combined boundary effect.
const SAMPLE_COUNT_SLACK: usize = 1000;

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()))
}

fn assert_decodes_to_expected(name: &str) {
    let bytes = fixture_bytes(name);
    let samples = decode_to_pcm16k_mono(&bytes).unwrap_or_else(|e| panic!("decode {name}: {e}"));
    let diff = samples.len().abs_diff(EXPECTED_SAMPLES);
    assert!(
        diff <= SAMPLE_COUNT_SLACK,
        "decoded {} samples from {name}, expected ~{EXPECTED_SAMPLES} (off by {diff})",
        samples.len(),
    );
    // Sanity: the file is a 0.5-amplitude sine, so the samples should
    // actually contain audio rather than silence.
    let peak = samples.iter().fold(0.0f32, |acc, &s| acc.max(s.abs()));
    assert!(
        peak > 0.1,
        "fixture {name} decoded to near-silence (peak {peak})"
    );
}

#[test]
fn decodes_mp3_fixture() {
    assert_decodes_to_expected("sine_440_2s.mp3");
}

#[test]
fn decodes_m4a_aac_fixture() {
    assert_decodes_to_expected("sine_440_2s.m4a");
}

#[test]
fn decodes_webm_opus_fixture() {
    assert_decodes_to_expected("sine_440_2s.webm");
}

#[test]
fn decodes_ogg_opus_fixture() {
    assert_decodes_to_expected("sine_440_2s.opus");
}

/// An EBML variable-length integer at `at` and its length, its marker kept
/// (an ID) or cleared (a size).
fn vint(bytes: &[u8], at: usize, keep_marker: bool) -> (u64, usize) {
    let length = bytes[at].leading_zeros() as usize + 1;
    let first = if keep_marker {
        bytes[at]
    } else {
        bytes[at] & 0xFFu8.checked_shr(length as u32).unwrap_or(0)
    };
    let value = bytes[at + 1..at + length]
        .iter()
        .fold(u64::from(first), |value, &byte| {
            (value << 8) | u64::from(byte)
        });
    (value, length)
}

const UNKNOWN_SIZE: [u8; 8] = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];

/// The WebM fixture as the recorder leaves a take a crash cut off: its
/// header, its Info, Tracks and Cluster, the Segment's and the Cluster's
/// sizes unknown, and no SeekHead or Cues.
fn open_take() -> Vec<u8> {
    const SEGMENT: u64 = 0x1853_8067;
    const INFO: u64 = 0x1549_A966;
    const TRACKS: u64 = 0x1654_AE6B;
    const CLUSTER: u64 = 0x1F43_B675;
    let fixture = fixture_bytes("sine_440_2s.webm");
    let (header_size, header_length) = vint(&fixture, 4, false);
    let segment = 4 + header_length + header_size as usize;
    let (id, id_length) = vint(&fixture, segment, true);
    assert_eq!(id, SEGMENT);
    let (_, size_length) = vint(&fixture, segment + id_length, false);
    let mut take = fixture[..segment + id_length].to_vec();
    take.extend_from_slice(&UNKNOWN_SIZE);
    let mut at = segment + id_length + size_length;
    while at < fixture.len() {
        let (id, id_length) = vint(&fixture, at, true);
        let (size, size_length) = vint(&fixture, at + id_length, false);
        let body = at + id_length + size_length;
        let end = body + size as usize;
        match id {
            INFO | TRACKS => take.extend_from_slice(&fixture[at..end]),
            CLUSTER => {
                take.extend_from_slice(&fixture[at..at + id_length]);
                take.extend_from_slice(&UNKNOWN_SIZE);
                take.extend_from_slice(&fixture[body..end]);
            }
            _ => {}
        }
        at = end;
    }
    take
}

/// A take cut off anywhere in its blocks decodes to its whole blocks: a
/// torn last block ends the audio. The same tear in a finished file, whose
/// Segment states its size, is damage, and fails at least once. This holds
/// the decoder to the message the WebM reader gives a torn block, so a
/// symphonia upgrade that changes it fails here.
#[test]
fn a_torn_take_decodes_to_its_whole_blocks_and_a_torn_finished_file_fails() {
    let open = open_take();
    let whole = decode_to_pcm16k_mono(&open).expect("the whole take decodes");
    assert!(whole.len().abs_diff(EXPECTED_SAMPLES) <= SAMPLE_COUNT_SLACK);
    let segment_size = open
        .windows(UNKNOWN_SIZE.len())
        .position(|window| window == UNKNOWN_SIZE)
        .unwrap();
    let mut finished = open.clone();
    let stated = (open.len() - segment_size - 8) as u64 | 1 << 56;
    finished[segment_size..segment_size + 8].copy_from_slice(&stated.to_be_bytes());
    let first_cluster = open
        .windows(4)
        .position(|id| id == [0x1F, 0x43, 0xB6, 0x75])
        .unwrap();
    let mut failures = 0;
    for cut in (first_cluster..open.len()).step_by(7) {
        let samples = decode_to_pcm16k_mono(&open[..cut])
            .unwrap_or_else(|error| panic!("torn at {cut}: {error}"));
        assert!(samples.len() <= whole.len(), "torn at {cut}");
        if decode_to_pcm16k_mono(&finished[..cut]).is_err() {
            failures += 1;
        }
    }
    assert!(failures > 0, "a torn finished file never failed");
}
