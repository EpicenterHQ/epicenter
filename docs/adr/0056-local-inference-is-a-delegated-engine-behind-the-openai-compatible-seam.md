# 0056. Local inference is a delegated engine behind the OpenAI-compatible seam; the runtime is a swappable default

- **Status:** Accepted
- **Date:** 2026-06-22
- **Relates:** ADR-0050 (the OpenAI-compatible wire this seam is built on), ADR-0054 (hosted-vs-custom backend, the seam this generalizes from chat to voice), [ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md) (the audience-scoped bearer that makes a base-URL swap safe), ADR-0049 (inference is its own swappable box)

## Context

ADR-0054 made a chat app's inference backend a user setting: hosted (the metered Epicenter gateway) or custom (any OpenAI-compatible base URL). The custom arm already lets a user point at a local Ollama, a self-hosted gateway, or OpenRouter. Two questions were left open: which local runtime we bless and document, and whether the same pattern covers Whispering's transcription and the language apps' speech, not just chat. "Local models" is not one surface: chat is an LLM, transcription is speech-to-text, pronunciation is text-to-speech, and each is a different model class served by a different engine.

## Decision

Local inference is a delegated engine reached over the OpenAI-compatible wire. We do not build an inference engine, and we do not bundle one by default. A runtime swap is a base-URL change and nothing more: if the URL is the Epicenter origin, the audience-scoped bearer ([ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md)) attaches the login; any other URL is a plain fetch with an optional user key (ADR-0054), and the Epicenter token is structurally withheld.

The seam is identical across the three model classes; only the OpenAI route differs:

- **Chat (LLM), `/v1/chat/completions`.** Blessed local default: **Ollama** (`http://localhost:11434/v1`), which already speaks the exact wire the client consumes. Documented, zero new code.
- **Transcription (STT), `/v1/audio/transcriptions`.** Blessed engine: **WhisperKit** (Argmax, MIT) on Apple silicon, embedded in-process via Core ML or run through its OpenAI-compatible local server; **whisper.cpp** (MIT) is the cross-platform fallback. Whispering already speaks this route for cloud STT.
- **Speech (TTS), `/v1/audio/speech`.** Blessed engine: **Kokoro** (Apache-2.0, English and Mandarin, runnable from a roughly 90 MB quantized ONNX build on a laptop CPU) behind the Kokoro-FastAPI server; **Piper** is the lighter alternative.

The runtime behind "custom" is an implementation detail: a user's own Ollama, a bundled sidecar, an in-process whisper.cpp, or a single OpenAI-compatible voice server such as **Speaches** (MIT, faster-whisper for STT plus Kokoro/Piper for TTS) that serves both audio routes at once. Swapping any of these touches no app code. The future-proofing is the seam, not the runtime.

## Consequences

- **The blessed defaults are documentation, not a dependency.** Pointing the custom backend at Ollama works on the shipped build today; the doc recipe (`localhost:11434/v1` plus a Qwen model) is the whole deliverable for the chat case.
- **The desktop shell's "managed local" is UX polish over a delegated engine,** not a rebuilt engine: detect-or-launch the runtime, drive `pull` from a button, and auto-point the custom backend at `localhost:<port>/v1`. Detecting the user's existing Ollama is the cheap floor; bundling a sidecar (whisper.cpp is lighter than the whole Ollama binary) is earned by demand, not shipped speculatively.
- **There are three deployment modes under one seam:** hosted (we run inference, metered), local-delegated (the user's own engine, we point at it), and local-bundled (the shell ships or launches the engine). "Managed" means hosted inference in the first sense and managed UX in the others; the seam is the same in all three.
- **A fully local language app becomes reachable:** a small local Qwen for the conversation, deterministic local gloss for the dictionary, and Kokoro for pronunciation, with no cloud call. A deployed web app cannot reach a `localhost` engine unless the runtime allows the app's origin (CORS); the extension and the desktop shell can.
- **Trade-off, and what this forecloses.** We will not own the local engine, so we inherit its model coverage, its quirks, and its lifecycle, and we accept that the best engine per class differs by platform (WhisperKit is Apple-only; whisper.cpp is the portable floor). That is the cost of refusing to build or bundle, and it is the right cost: the seam absorbs runtime churn, so the engine can change without an app change.

## Considered alternatives

- **Build our own inference engine.** Rejected: it is an enormous undertaking, and the OpenAI-compatible seam already makes any engine swappable, so there is nothing to gain.
- **Bundle a runtime by default.** Rejected: gigabyte models, GPU drivers, and crash handling are a real distribution and support burden; detect-or-launch the user's engine is the floor, and bundling is earned later.
- **Pick one runtime for all model classes.** Rejected: no engine serves chat, STT, and TTS well. Speaches is the closest single OpenAI-compatible voice server (STT plus TTS) and is named as that option, but on desktop an in-process Whisper often beats running a Python server, so the seam stays the commitment, not the runtime.
- **Treat "local" as a separate code path from cloud.** Rejected: it is the same OpenAI wire on a different base URL; a separate path would duplicate the resolver and the bearer rule that [ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md) and ADR-0054 already settled.
