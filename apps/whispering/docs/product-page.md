# Whispering product-page draft

Copy for the completed independent product at `whispering.bradenwong.com`. Page design comes last. Production notes follow the copy; they are not page content.

## Opening

**Whispering**

**Press a shortcut. Speak. Get text.**

Free and open source ❤️

By [Braden Wong](https://bradenwong.com). Built on [Epicenter](https://epicenter.so).

Whispering turns your voice into text for the application you’re using.

## How it works

1. Press your recording shortcut and speak.
2. Stop recording to transcribe the audio.
3. Insert the transcript at your cursor, or copy it from Whispering and paste it into a message, document, or draft.

Whispering keeps the recording and its results. You can listen again or clean up grammar and punctuation while retaining the original.

## Decide where transcription runs

Use an on-device model, a remote service, or a self-hosted endpoint. On-device transcription processes audio locally. A remote connection sends audio to the endpoint you select. Optional transcript cleanup sends text to its configured processing endpoint. Remote services may charge for transcription or cleanup.

## Open your files outside Whispering

Your recordings and transcripts are audio and Markdown files. Play the audio in another application, read the text in an editor, or work with it in a script. Copying the data folder keeps the actual recordings with it.

## Why I built Whispering

I really like hands-free voice dictation. For years, I relied on transcription tools that were _almost_ good, but they were all closed-source. Even those claiming to be "local" or "on-device" were still black boxes that left me wondering where my audio really went.

So I built Whispering. I wanted an open-source tool I could inspect without giving up the usability of the paid apps I was using.

## Production notes

- Place a real demonstration after the opening: shortcut, recording, transcript, and delivery into a text field. Do not present a simulation as evidence of a working product.
- Add the primary installation action beside the opening and after the final section once the independent release destination and supported platforms are verified.
- Add the source link to `braden-w/whispering` once the independent repository exists. Do not substitute Epicenter desktop downloads or the old `whispering.epicenter.so` address.
- First-run copy must follow the chosen default: whether a model is ready to use or a connection must be configured. No account requirement or default model is selected here.
- Keep pricing, provider availability, and permission instructions tied to the implemented workflows.
- Confirm repository-relative documentation and image paths when extracting the app. Development and help links currently point into this monorepo.

The [public-materials plan](../../../specs/20260930T210607-personal-software-public-materials.md) owns unresolved installation, demo, source, and deployment destinations.
