<p align="center">
  <img width="180" src="./src/lib/assets/studio-microphone.png" alt="Whispering">
</p>

# Whispering

**Press a shortcut. Speak. Get text.**

Free and open source ❤️

By [Braden Wong](https://bradenwong.com). Built on [Epicenter](https://epicenter.so).

Whispering is a speech-to-text app that turns your voice into text for the application you’re using.

[Website](https://whispering.bradenwong.com) · [Getting started](#getting-started) · [Development](docs/development.md) · [Help](#help)

- Record with a keyboard shortcut.
- Transcribe on your device or through a selected service.
- Clean up a transcript while retaining the original.

## Why I built Whispering

I really like hands-free voice dictation. For years, I relied on transcription tools that were _almost_ good, but they were all closed-source. Even those claiming to be "local" or "on-device" were still black boxes that left me wondering where my audio really went.

So I built Whispering. I wanted an open-source tool I could inspect without giving up the usability of the paid apps I was using.

## Getting started

Choose an on-device model or configure a transcription connection. Allow microphone access and set your recording shortcut. Text delivery may also require system permissions; you can copy a transcript from Whispering.

## How it works

1. Press your recording shortcut and speak.
2. Stop recording to transcribe the audio.
3. Insert the transcript at your cursor, or copy it from Whispering and paste it where you need it.

Whispering keeps the recording and its results. You can listen again, transcribe with another model, or clean up grammar and punctuation without replacing the original.

## Audio and files

| Processing | Where it happens |
| --- | --- |
| On-device transcription | Audio is processed locally |
| Remote transcription | Audio is sent to the selected endpoint |
| Optional transcript cleanup | Transcript text is sent to its configured processing endpoint |

Remote services may charge for transcription or cleanup.

Whispering saves recordings and transcripts as audio and Markdown files in a data folder. Open the recordings in an audio player, read the transcripts in an editor, or work with them in a script. A complete copy of the folder includes the audio files themselves.

## Development

See [development and verification](docs/development.md) for build commands and native integration. Epicenter’s [data model](../../README.md#data-model) explains the shared foundation.

## Help

For recording problems, check microphone access and the selected input device. For transcription failures, check the connection, model, and credentials.

[Report a bug](https://github.com/EpicenterHQ/epicenter/issues) with your app version, operating system, reproduction steps, and error message. Leave out credentials and private recordings.

## License

Whispering is AGPL-3.0-or-later. Previously published MIT versions retain their original license. See the [licensing strategy](../../docs/licensing/licensing-strategy.md).
