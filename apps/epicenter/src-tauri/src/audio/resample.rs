//! Mono sample-rate conversion via rubato, for the decoder: any rate to
//! 16 kHz for local transcription. The resampler is fixed-input sinc with
//! BlackmanHarris2 windowing, the configuration the recorder plugin's writer
//! also uses (`tauri-plugin-epicenter-recorder/src/rate.rs`), so a recording
//! and an uploaded file reach the transcriber converted the same way.

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

use super::error::AudioError;

/// Maximum ratio we configure rubato with. Sources slower than
/// `target_rate / 8` cannot be resampled.
const MAX_RATIO: f64 = 8.0;

/// Resample mono `samples` from `source_rate` to `target_rate`. Returns the
/// input untouched if the rates already match or the input is empty.
pub fn resample_mono(
    samples: Vec<f32>,
    source_rate: u32,
    target_rate: u32,
) -> Result<Vec<f32>, AudioError> {
    if source_rate == target_rate || samples.is_empty() {
        return Ok(samples);
    }

    let ratio = target_rate as f64 / source_rate as f64;
    if ratio > MAX_RATIO {
        return Err(AudioError::resample(format!(
            "source rate {source_rate} Hz too far below target rate {target_rate} Hz",
        )));
    }

    let params = SincInterpolationParameters {
        sinc_len: 64,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };

    let chunk_size = 1024;
    let mut resampler = SincFixedIn::<f32>::new(ratio, MAX_RATIO, params, chunk_size, 1)
        .map_err(|e| AudioError::resample(format!("resampler init failed: {e}")))?;

    let expected_len = (samples.len() as f64 * ratio).round() as usize;
    let mut output = Vec::with_capacity(expected_len);

    let mut pos = 0;
    while pos < samples.len() {
        let end = (pos + chunk_size).min(samples.len());
        let mut chunk: Vec<f32> = samples[pos..end].to_vec();
        if chunk.len() < chunk_size {
            // rubato's fixed-input variant requires every call to be the full
            // chunk size; pad the trailing chunk with silence.
            chunk.resize(chunk_size, 0.0);
        }

        let waves_out = resampler
            .process(&[chunk], None)
            .map_err(|e| AudioError::resample(format!("resample step failed: {e}")))?;

        output.extend_from_slice(&waves_out[0]);
        pos += chunk_size;
    }

    // Trim the synthetic tail produced by the zero-padded final chunk.
    output.truncate(expected_len);

    Ok(output)
}
