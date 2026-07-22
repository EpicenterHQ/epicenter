pub mod capture;
pub mod commands;
pub mod error;
pub mod recorder;
pub mod recording_audio;

pub use commands::{
    acknowledge_recording_capture, cancel_recording, close_recording_session,
    enumerate_recording_devices, get_current_recording_id, init_recording_session, start_recording,
    stop_recording,
};
pub use error::RecorderError;
pub use recorder::Recorder;
pub(crate) use recording_audio::read_recording_bytes;
