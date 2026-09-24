# 0180. Epicenter has one host-owned active local transcription model

- **Status:** Accepted
- **Date:** 2026-07-25
- **Amends:** [ADR-0012](0012-transcription-settings-are-read-at-use-not-mirrored-into-rust.md) at the model-identity boundary only. The model name stops being an application-owned value carried per call; read-at-use delivery and the refusal to mirror config into Rust stand unchanged.
- **Amended by:** [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md) at the application-facing readiness and recovery boundary.
- **Amended by:** [ADR-0397](0397-native-inference-selects-an-installed-model-explicitly.md) at the active-model clause: a request names an installed model, so the refusal of a per-request `modelId` and of an application-facing model listing is withdrawn. Host-owned residency, Home-owned administration, and naming the exact model on every transcript stand.
- **Relates:** [ADR-0016](0016-prewarm-the-cold-model-load-and-refuse-the-rest-of-the-latency-menu.md), [ADR-0022](0022-rust-owns-the-models-folder-the-webview-owns-the-catalog.md), [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md)

## Context

Local transcription is one machine-wide resource: one model cache, one
accelerator, one RAM budget. ADR-0012 made every transcription setting an
application-owned value delivered per call in `TranscriptionSpec`, and the model
name rode along with the language and the prompt. That was right when Whispering
was the only caller on the machine: the value's owner and the resource's only
user were the same program.

Epicenter now serves a catalog of full-trust apps on one origin (ADR-0179).
Today only the Whispering window holds the transcription commands, so the
per-call shape has one caller and no observable conflict. That is a fact about
the current capability grants, not a property of the design: the moment a second
surface can transcribe, a per-call model name lets it change which model the
shared cache holds, on any request, invisibly to every other caller and to the
user. The value looks like a setting and behaves like a mutation of shared
machine state, and the right time to fix that shape is before a second caller
exists.

Whispering also fuses two decisions into one act. Picking a transcriber writes
both `settings.transcription.service` and
`transcription.local.selectedModel`, so choosing a route and reassigning a
machine-wide resource are the same click.

## Decision

Epicenter has exactly one **active** local transcription model. The host owns
it; Epicenter Home administers it.

**Every ordinary local transcription runs on the active model or fails
explicitly.** There is no per-request `modelId`, no app-level override, and no
silent substitution. An application requests transcription; it does not request
a model.

**Home owns model administration:** which model is active, and downloading,
deleting, and unload policy. Whispering keeps choosing the transcription route,
local against a cloud provider, and that choice stays app-owned. Route selection
and active-model selection are different questions, and this record governs only
the local route.

**Residency is private.** How many model copies are resident or warm, which
accelerator or backend runs, caching, queueing, and eviction are host
implementation details with no application-visible surface. The invariant must
keep holding unchanged if the host later keeps several models resident at once.

**Every successful local transcript reports the exact model that produced it.**
The compatibility test: with the active model unchanged, identical ordinary
local requests must name the same model no matter how residency is arranged.

**Unsupported semantic requests fail explicitly** rather than degrading into
something the caller did not ask for. Advisory hints may be adjusted only when
the result reports which options were actually applied.

**There is no ordinary application-facing model listing.** Enumeration is
download-manager inventory. Exposing it invites every app to grow its own picker
and teaches callers to treat residency as addressable.

The word is load-bearing. It is the **active** model, not the default (which
implies a supported override), not the preferred (which implies a fallback), and
not the selected (which names a UI act and collides with Whispering's existing
`transcription.local.selectedModel` key).

### What this changes in ADR-0012, and what it does not

Unchanged: the frontend owns setting values and Rust owns mechanism only; no
ambient configuration is mirrored into Rust where it can go stale; values
consumed at use are read at use; the unload clock is reconciled into Rust
because a backgrounded webview timer throttles exactly when idle eviction must
fire.

Changed: model identity is no longer among the values an *application* owns and
carries. It is host state. This record fixes who chooses, not where runtime
resolution happens. Whichever component resolves the active model must still
read it at the point of use, so a model file that appears on disk after a failed
load works on the very next call without a restart.

ADR-0016 is untouched. Audio stays addressed by blob ID and never crosses the
JS/Tauri boundary, prewarm stays, and streaming and chunked partial
transcription stay refused. Nothing here reopens that refusal, and no partial
result callback is introduced as future-proofing. Where ADR-0016 says prewarm
loads "the selected local model," read the active model: prewarm still warms
exactly the model transcribe will use, because there is only one.

ADR-0022 is untouched. Rust still owns the models folder and renders the
completeness verdict, and a webview still owns the catalog data and display.
This record only settles which webview: Home, rather than each app that wants
local transcription.

## Consequences

- Widening the transcription surface beyond Whispering no longer carries the
  risk that one app evicts another's warm model or mutates machine-wide state
  through an ordinary request. The failure mode is closed before it can appear.
- Model administration has one home and one picker instead of one per app that
  ever wants local transcription.
- Whispering's `transcription.local.selectedModel` device-config key and the
  model half of `TranscriptionSpec` lose their owner. Moving them is
  implementation work this record does not schedule.
- An application that needs one specific model has no supported way to get it.
  That is the intended cost: a real need reopens this decision with evidence
  rather than routing around it per request.
- The host may later hold several models resident, or none, without any
  application observing a semantic change.
- Reporting the exact model on every transcript makes an accidental substitution
  detectable instead of silent.
- Choosing a local transcriber inside an app becomes two separate acts by two
  owners, which is more steps than today's fused click.

## Considered alternatives

- **Per-request `modelId`, or an app-level override.** Rejected: one shared
  cache turns it into a hidden machine-wide mutation decided by whichever app
  called last.
- **`fast` and `accurate` profiles instead of a model.** Rejected: the mapping
  is unstable across hardware and model families, so the same profile silently
  means different things on different machines.
- **App-owned engine or session handles.** Rejected: they hand an application a
  resource lease over the shared accelerator, and with it denial-of-service
  semantics.
- **An ordinary application-facing model list.** Rejected: it exposes
  download-manager inventory and encourages duplicated pickers in every app.
- **Make "exactly one resident model" the public invariant.** Rejected: it names
  an implementation arrangement, foreclosing multiple resident copies for no
  semantic gain.
