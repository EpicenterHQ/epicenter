# Audio decoder test fixtures

These fixtures belong to the transcription plugin's audio decoder
(`audio::decode_to_pcm16k_mono`), which Whispering and the recorder plugin's
tests use. They are consumed by `../decode_fixtures.rs`.

Each file is a 2-second 440 Hz mono sine wave at 0.5 amplitude. The audio
content is identical; only the container/codec differs. They exercise the
container/codec permutations the in-app decoder is expected to handle.

The WebM file is a finished one as ffmpeg writes it: a SeekHead before its
Cluster and Cues at its end. The test that cuts it off depends on both, so
regenerate it with ffmpeg writing to a file, not a pipe.

Total size of all fixtures: ~55 KB. Keep new fixtures small (a few seconds
of mono audio) so the repo doesn't bloat.

## Regenerating

```sh
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2:sample_rate=48000" \
  -c:a pcm_s16le /tmp/sine_48k_mono.wav

# MP3 (libmp3lame), 64 kbps
ffmpeg -y -i /tmp/sine_48k_mono.wav -c:a libmp3lame -b:a 64k sine_440_2s.mp3

# AAC-LC inside ISO MP4, 64 kbps
ffmpeg -y -i /tmp/sine_48k_mono.wav -c:a aac -b:a 64k sine_440_2s.m4a

# Opus inside WebM (Matroska), 32 kbps (what browser MediaRecorder produces)
ffmpeg -y -i /tmp/sine_48k_mono.wav -c:a libopus -b:a 32k sine_440_2s.webm

# Opus inside OGG, 32 kbps
ffmpeg -y -i /tmp/sine_48k_mono.wav -c:a libopus -b:a 32k sine_440_2s.opus
```
