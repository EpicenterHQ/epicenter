//! Standalone fixture for native flat publication. No microphone or Tauri.
//! Compile with rustc, then publish ROOT KEY [--wait] or validate KEY.
#[path = "../../../apps/epicenter/src-tauri/src/flat_blobs.rs"]
mod flat_blobs;

use std::io::{self, Write};
use std::path::Path;

fn wav() -> Vec<u8> {
    let samples: Vec<i16> = (0..800)
        .map(|index| if index % 20 < 10 { 1600 } else { -1600 })
        .collect();
    let length = (samples.len() * 2) as u32;
    let mut bytes = Vec::new();
    bytes.extend(b"RIFF");
    bytes.extend((36 + length).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes()); // PCM
    bytes.extend(1u16.to_le_bytes()); // mono
    bytes.extend(8000u32.to_le_bytes());
    bytes.extend(16000u32.to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(length.to_le_bytes());
    for sample in samples {
        bytes.extend(sample.to_le_bytes());
    }
    bytes
}

fn run(args: &[String]) -> io::Result<()> {
    if args.first().map(String::as_str) == Some("validate") && args.len() == 2 {
        return flat_blobs::validate_key(&args[1]);
    }
    if args.first().map(String::as_str) != Some("publish") || !(3..=4).contains(&args.len()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Usage: publish ROOT KEY [--wait] | validate KEY",
        ));
    }
    if !args[2].ends_with(".wav") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The WAV fixture requires a .wav saved key",
        ));
    }
    let mut blob = flat_blobs::StagedBlob::stage(Path::new(&args[1]), &args[2])?;
    blob.writer()?.write_all(&wav())?;
    if args.get(3).map(String::as_str) == Some("--wait") {
        println!("READY");
        io::stdout().flush()?;
        let mut line = String::new();
        if io::stdin().read_line(&mut line)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Race fixture was not released",
            ));
        }
    }
    let receipt = blob.commit()?;
    // Teardown must never remove the completed file.
    blob.discard()?;
    println!("SAVED {} {}", receipt.key, receipt.size);
    Ok(())
}

fn main() {
    if let Err(error) = run(&std::env::args().skip(1).collect::<Vec<_>>()) {
        eprintln!("{error}");
        std::process::exit(match error.kind() {
            io::ErrorKind::AlreadyExists => 17,
            io::ErrorKind::InvalidInput => 2,
            _ => 1,
        });
    }
}
