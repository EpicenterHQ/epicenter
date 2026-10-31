# Self-hosted transcription with Speaches

Epicenter reaches every transcription service over one OpenAI-compatible wire:
the shared `transcribe(audio, connection)` client in `@epicenter/client` POSTs
multipart audio to `{baseUrl}/audio/transcriptions` and reads back `{ text }`.
A connection is just `{ baseUrl, apiKey? }` (ADR-0060), so pointing it at a
server you run is configuration, not code. [Speaches](https://speaches.ai) is the
blessed self-hosted delegate (ADR-0056): a maintained, MIT-licensed FastAPI
server that speaks the exact wire (`/v1/audio/transcriptions`, `/v1/audio/speech`,
a realtime WebSocket) and serves faster-whisper and Parakeet/NeMo models. We do
not ship a transcription server of our own; a server that wants in conforms to
the wire.

When the bytes stay on a box you operate, they never reach Epicenter or any cloud
provider (see [the trust model](../trust-model.md)). This is the private,
free transcription path for desktop and the browser extension.

## Run Speaches

The published image serves the wire on port 8000:

```sh
docker run --rm -p 8000:8000 ghcr.io/speaches-ai/speaches:latest
```

Pull a model once (Whisper large v3 turbo is the fast default; Parakeet is also
available):

```sh
curl http://localhost:8000/v1/models/Systran/faster-whisper-large-v3 -X POST
```

A GPU is optional but transforms throughput. See the Speaches docs for the CUDA
image and model catalog.

## Point a connection at it

In any surface that can reach `localhost` (the browser
extension), add a custom inference connection:

```txt
Base URL   http://localhost:8000/v1     (the /v1 is part of the base)
API key    (leave empty; a local server needs none)
Model      Systran/faster-whisper-large-v3
```

That is the whole setup. The same connection drives transcription today and TTS
or chat later, because a connection carries no capability, only where and how to
authenticate. To transcribe from code, the call is identical to the hosted one,
only the connection differs:

```ts
import { transcribe } from '@epicenter/client';

await transcribe(audio, { baseUrl: 'http://localhost:8000/v1' }, {
  model: 'Systran/faster-whisper-large-v3',
});
```

## CORS, for a browser tab

A deployed web page runs on a different origin than `localhost:8000`, so the
browser sends a CORS preflight before the `POST`. Speaches must answer it or the
request is blocked before it leaves the tab. Allow the origin you serve the app
from (and `OPTIONS` / `POST` / the `authorization` and `content-type` headers).
Speaches reads its allowed origins from configuration; set it to your app origin
rather than `*` so a stray page cannot drive your box. Desktop and the extension
do not hit this: they are not a web origin, so no preflight applies, which is why
the browser-tab path is the one that needs the CORS line and `localhost` from a
deployed web page does not work at all (point the web app at the hosted gateway
or your own remote URL instead).
