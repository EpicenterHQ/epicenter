# 0362. Inference connections do not require runtime management

- **Status:** Proposed
- **Date:** 2026-09-08
- **Relates:** [ADR-0056](0056-local-inference-is-a-delegated-engine-behind-the-openai-compatible-seam.md), [ADR-0059](0059-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md), and [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) establish delegated engines, multiple connections, and the resolved transport.
- **Unbuilt:** Guided runtime setup and optional model-management actions; cross-app connection sharing and desktop-to-browser access require separate storage and authorization designs.

## Context

`packages/client/src/connection.ts` already provides Ollama and LM Studio
presets alongside generic URL connections. The app-shell inference picker holds
multiple connections. Whispering also resolves custom completion endpoints in
`apps/whispering/src/lib/operations/completion-target.ts`.

Native transcription already has host-owned model administration in
`apps/epicenter/src-tauri/src/transcription/mod.rs`, governed by
[ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md).
The optional integrations below concern external inference servers; they do not
turn that existing native capability into an HTTP connection. The native
transport in `packages/app/src/native-ai.ts` presents it as an OpenAI-wire
destination over IPC, with no socket.

Local setup could grow from entering a URL into downloading models or starting
an engine. Requiring every endpoint to support those operations would turn a
useful inference contract into a runtime-management framework. Choosing Ollama
for a guided setup must not make it a dependency of every local workflow.

## Decision

**A usable inference connection requires only the supported inference operation, not control of its runtime.**

The built-in Epicenter transport coexists with multiple user-configured
OpenAI-compatible endpoints. Ollama and LM Studio are editable setup presets;
users can connect multiple instances or enter another server's URL. A preset
does not establish that the server supports every OpenAI operation.

**Runtime management is an optional integration beside the inference connection.**

The responsibilities remain separate:

| Responsibility | Owner |
| --- | --- |
| Recording, transcription, transformations, retries, and saved results | The consuming app, such as Whispering |
| Model downloads, inventory, loading, and removal | The selected runtime; Epicenter may offer controls through its management API |
| Model execution and CPU/GPU scheduling | The inference engine |
| Credential handling and access to the endpoint | The connection transport and the endpoint's access controls |

A future Ollama download button uses Ollama's management API. Generic endpoints
remain usable without download, memory-inspection, or process-control support.
Epicenter does not stop a user-owned runtime when an app closes. Bundling an
additional engine or taking ownership of an external runtime's process lifetime
requires a separate decision. Native transcription keeps host-owned model
administration: Epicenter Home installs, deletes, and unloads. It no longer keeps
one host-owned active model, because an application names an installed model in
its request like any other connection
([ADR-0397](0397-native-inference-selects-an-installed-model-explicitly.md)).

**Each workflow step selects an operation that its endpoint supports.**

Whispering can use different endpoints for transcription and text
transformations. Model discovery alone does not prove audio, tool, or structured
output support. Setup tests the required operation where practical and retains
manual model entry when discovery is unavailable. A connection failure never
silently redirects local work to hosted inference.

For example, Alice connects Ollama in Whispering's text settings, selects an
installed model, and keeps using a separate transcription engine. Another URL
can serve the same text operation without offering Ollama's management features.

**Browser access and desktop runtime ownership are independent capabilities.**

A browser SPA can connect to an already-running endpoint when its origin,
browser permissions, and transport rules permit it. It cannot start a local
executable. Exposing an Epicenter-managed engine to browser sites needs an
explicit authorization design. A loopback URL identifies the browser's device;
it does not prove the server performs inference locally or never forwards data.

## Consequences

Users can reuse an existing model installation without installing another engine
for Epicenter. Runtime-specific setup can improve incrementally without changing
the generic inference contract. Epicenter inherits each endpoint's supported
operations and reports unavailable features instead of assuming full parity.

This does not choose Ollama as the sole runtime, select a hosted upstream,
replace native transcription engines, or choose cross-app connection storage.

## Considered alternatives

- Require Ollama for local inference: excludes other compatible servers and
  couples app workflows to one runtime's installation.
- Require a universal management API: generic inference endpoints do not owe
  Epicenter model downloads or process control.
- Offer only raw URLs forever: preserves compatibility but prevents guided
  setup for commonly used runtimes.

## References

- [Ollama's OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility)
- [Open WebUI's connection protocols](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/)
- [LM Studio's inference and model-management API](https://lmstudio.ai/docs/developer/rest)
