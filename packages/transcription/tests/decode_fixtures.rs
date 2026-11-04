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
