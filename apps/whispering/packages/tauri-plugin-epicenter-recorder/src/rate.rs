//! Conversion from the rate a microphone runs at to the rate a recording is
//! written at.
//!
//! The microphone is opened at the rate it already runs at, because asking a
//! macOS device for another rate changes that device's rate for every process
//! using it, and cpal leaves it changed after the stream closes: a call in
//! progress on the same microphone would go silent. So the rate is converted
//! here, on the writer thread, as chunks arrive.
//!
//! The sinc parameters are the ones the shell's own decoder uses to bring an
//! uploaded file to 16 kHz for transcription, so a recording and a file sound
//! the same to the transcriber.

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

use crate::error::RecorderError;
use crate::recorder::Result;

/// Input frames the resampler takes per call: about 21 ms at 48 kHz, so the
/// file trails the microphone by at most that much plus the filter's delay.
const CHUNK_FRAMES: usize = 1024;

/// A stateful mono converter from one fixed rate to another.
pub(crate) struct RateConverter {
    resampler: SincFixedIn<f32>,
    ratio: f64,
    /// Input not yet a whole chunk.
    pending: Vec<f32>,
    /// Input frames received, to know how much output the stream is owed.
    received: u64,
    /// Output frames handed back.
    emitted: u64,
}

fn to_f32(sample: i16) -> f32 {
    sample as f32 / 32_768.0
}

fn to_i16(sample: f32) -> i16 {
    (sample * 32_768.0)
        .round()
        .clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

fn failed(error: impl std::fmt::Display) -> RecorderError {
    RecorderError::failed(format!("convert the microphone's rate: {error}"))
}

impl RateConverter {
    pub(crate) fn new(from: u32, to: u32) -> Result<Self> {
        let ratio = to as f64 / from as f64;
        let parameters = SincInterpolationParameters {
            sinc_len: 64,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };
        // rubato's fixed-input sinc resampler starts its output already
        // compensated for the filter: from 48 kHz, output n is computed at
        // input 3(n + 1), about one output sample late, so there is no
        // filter delay to skip. `finish` pushes out the tail the filter
        // still holds.
        let resampler =
            SincFixedIn::<f32>::new(ratio, 1.0, parameters, CHUNK_FRAMES, 1).map_err(failed)?;
        Ok(Self {
            resampler,
            ratio,
            pending: Vec::with_capacity(CHUNK_FRAMES),
            received: 0,
            emitted: 0,
        })
    }

    /// Convert `samples`, answering the output every whole chunk produced.
    pub(crate) fn push(&mut self, samples: &[i16]) -> Result<Vec<i16>> {
        self.received += samples.len() as u64;
        let mut output = Vec::new();
        for &sample in samples {
            self.pending.push(to_f32(sample));
            if self.pending.len() == CHUNK_FRAMES {
                let chunk = std::mem::replace(&mut self.pending, Vec::with_capacity(CHUNK_FRAMES));
                let converted = self.resampler.process(&[chunk], None).map_err(failed)?;
                self.take(&converted[0], &mut output);
            }
        }
        Ok(output)
    }

    /// End the stream: the partial chunk and the filter's tail, trimmed to the
    /// length the input was owed, so a second at the device's rate is a
    /// second here.
    pub(crate) fn finish(mut self) -> Result<Vec<i16>> {
        let owed = (self.received as f64 * self.ratio).round() as u64;
        let mut output = Vec::new();
        let pending = std::mem::take(&mut self.pending);
        if !pending.is_empty() {
            let converted = self
                .resampler
                .process_partial(Some(&[pending]), None)
                .map_err(failed)?;
            self.take(&converted[0], &mut output);
        }
        while self.emitted < owed {
            let converted = self
                .resampler
                .process_partial(None::<&[Vec<f32>]>, None)
                .map_err(failed)?;
            if converted[0].is_empty() {
                break;
            }
            self.take(&converted[0], &mut output);
        }
        let surplus = (self.emitted.saturating_sub(owed)) as usize;
        output.truncate(output.len().saturating_sub(surplus));
        Ok(output)
    }

    fn take(&mut self, converted: &[f32], output: &mut Vec<i16>) {
        self.emitted += converted.len() as u64;
        output.extend(converted.iter().map(|&sample| to_i16(sample)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, frequency: f32, seconds: f32) -> Vec<i16> {
        (0..(rate as f32 * seconds) as u32)
            .map(|index| {
                let t = index as f32 / rate as f32;
                ((2.0 * std::f32::consts::PI * frequency * t).sin() * 0.5 * i16::MAX as f32) as i16
            })
            .collect()
    }

    fn rms(samples: &[i16]) -> f64 {
        let sum: f64 = samples
            .iter()
            .map(|&sample| (sample as f64 / 32_768.0).powi(2))
            .sum();
        (sum / samples.len() as f64).sqrt()
    }

    /// Convert in chunks the size a microphone callback hands over.
    fn convert(from: u32, to: u32, input: &[i16]) -> Vec<i16> {
        let mut converter = RateConverter::new(from, to).unwrap();
        let mut output = Vec::new();
        for chunk in input.chunks(480) {
            output.extend(converter.push(chunk).unwrap());
        }
        output.extend(converter.finish().unwrap());
        output
    }

    #[test]
    fn a_second_at_the_device_rate_is_a_second_at_the_recording_rate() {
        for from in [44_100, 48_000, 96_000, 8_000] {
            let output = convert(from, 16_000, &tone(from, 440.0, 1.0));
            assert_eq!(output.len(), 16_000, "from {from} Hz");
        }
    }

    #[test]
    fn a_tone_keeps_its_loudness_and_its_timing() {
        let input = tone(48_000, 100.0, 1.0);
        let output = convert(48_000, 16_000, &input);
        // Away from the edges, the converted tone is the same tone: as loud,
        // and in step with one computed at 16 kHz. The residual allows the
        // fraction of a sample the filter lags by (about 0.01 here); a
        // ten-sample delay left in would leave about 0.14.
        let expected = tone(16_000, 100.0, 1.0);
        let middle = 2_000..14_000;
        let loudness = rms(&output[middle.clone()]) / rms(&expected[middle.clone()]);
        assert!((loudness - 1.0).abs() < 0.02, "loudness ratio {loudness}");
        let error: f64 = output[middle.clone()]
            .iter()
            .zip(&expected[middle.clone()])
            .map(|(&a, &b)| ((a as f64 - b as f64) / 32_768.0).powi(2))
            .sum::<f64>()
            / middle.len() as f64;
        assert!(error.sqrt() < 0.02, "residual {}", error.sqrt());
    }

    #[test]
    fn content_above_the_new_band_is_removed() {
        // 12 kHz cannot exist at 16 kHz; it must not fold back in as an alias.
        let output = convert(48_000, 16_000, &tone(48_000, 12_000.0, 1.0));
        assert!(rms(&output[2_000..14_000]) < 0.005);
    }

    #[test]
    fn nothing_in_is_nothing_out() {
        assert!(convert(48_000, 16_000, &[]).is_empty());
    }
}
