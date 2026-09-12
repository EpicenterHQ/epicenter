# Transcription providers, from first principles

**Superseded by**: `specs/20260912T112824-app-hub-and-whispering-transcription-collapse.md`

## Status

Open. This spec is a brief for a fresh agent. It supersedes the narrow scoped collapse in `20260527T002843-cloud-transcription-collapse.md` only if the agent recommends adopting its conclusions; otherwise, the narrower spec stays as the fallback.

## Why this spec exists

Three commits on `braden-w/transcription-rebase` collapsed the **local** transcription engines (whispercpp/parakeet/moonshine):

```
165c10b03  catalogs → $lib/constants/local-models.ts
b662724a4  inline engine dispatch in operations/transcribe.ts
03bb04a4b  drop dead Rust-error remap, rename to local-preflight
```

The narrative there was: main had already moved local dispatch into a single typed Tauri command, so the JS-side per-engine files were thin shims. Collapsing them was straightforward.

A follow-on spec (`20260527T002843-cloud-transcription-collapse.md`) attempted to apply the same pattern to the **cloud** providers and arrived at a narrow win: factor an `openai-shaped` adapter for OpenAI + Groq (Mistral verified non-conforming, ElevenLabs/Deepgram/Speaches left alone).

The user wants a different question asked: not "how do we apply the local pattern here?" but **"if we were designing the cloud transcription pipeline from scratch today, with everything we have learned, what shape would it take?"**

This spec hands that question to an agent with enough context that they can answer it honestly. The agent has full permission to question every architectural choice currently in place: file layout, naming (do these belong under `services/`?), the registry, the dispatch switch, the per-provider error types, the "service object with a transcribe method" shape, anything else they think is unearned.

## Required reading (in order)

```
1. apps/whispering/src/lib/operations/transcribe.ts
   The end-to-end flow. Pay attention to: dispatchCloudTranscription
   (6-case switch over provider id), dispatchLocalTranscription
   (post-collapse: same shape but Rust does the work),
   loadForCloudUpload (the "where do the audio bytes come from"
   bit), transcribeAudio (the public entry point).

2. apps/whispering/src/lib/services/transcription/cloud/*.ts
   All six provider files. Note the per-provider shape:
     - openai.ts, groq.ts: OpenAI-SDK contract (~150-180 lines each)
     - mistral.ts: OpenAI-SDK-ish but uses .complete(), no key check
     - elevenlabs.ts: ElevenLabsClient.speechToText.convert, minimal errors (67 lines)
     - deepgram.ts: own SDK
   And self-hosted:
     - apps/whispering/src/lib/services/transcription/self-hosted/speaches.ts
       raw HTTP via HttpServiceLive, arktype validation, friendly errors

3. apps/whispering/src/lib/services/transcription/registry.ts
   The TRANSCRIPTION_SERVICES array. UI uses this (icons, labels,
   capability flags, modelPathField / apiKeyField names). Notice
   that registry.ts is itself a redundant layer over the
   $lib/constants/transcription.ts TRANSCRIPTION record.

4. apps/whispering/src/lib/constants/transcription.ts
   The TRANSCRIPTION record (labels, models, capabilities). The
   single source of truth for "what providers exist."

5. apps/whispering/src/lib/services/transcription/index.ts
   The services aggregator that re-exports each provider with a
   shorter name. Mostly noise after the local collapse.

6. apps/whispering/src/lib/services/transcription/README.md
   The current architectural intent (which the agent is invited
   to question).
```

After that, skim:
- `apps/whispering/CLAUDE.md` (and its sibling `AGENTS.md`): codebase-level rules
- `apps/whispering/src/lib/services/transcription/utils.ts`: shared helpers
- `apps/whispering/src/lib/services/http.ts`: `customFetch` / `HttpServiceLive`

## Audit findings (from preceding passes)

These are facts the agent can rely on without re-verifying:

```
A. Mistral verified non-conforming to OpenAI-SDK shape.
   Uses client.audio.transcriptions.complete() not .create().
   Has no API-key format check. Adds an InvalidResponse variant.
   Cannot share an adapter with OpenAI/Groq.

B. Zero callsites in apps/whispering/src pattern-match on
   provider error names (e.g., OpenaiError.RateLimit,
   GroqError.Unauthorized). The only `error.name` switch in
   the entire src tree was mapLocalTranscriptionError, which
   was deleted in 03bb04a4b. This means: provider-specific
   error variants exist for documentation/typing but are not
   structurally consumed. Collapsing them to a single shared
   error type with a `provider` field would lose nothing
   observable to callers.

C. Settings access boundary is clean.
   apps/whispering/CLAUDE.md says services should not access
   settings or deviceConfig directly. The audit found only
   one violation: registry.ts imports the DeviceConfigKey
   type from device-config.svelte. No state-access leaks
   anywhere in services. The dispatch in
   operations/transcribe.ts is the single integration point
   between settings state and provider calls. This is a
   confirmed boundary, not an accidental one.
```

## Frames the agent is invited to use

These are explicit invitations to question the current shape. The agent is not required to follow any of them; they are starting points if the agent gets stuck.

### Frame 1: "Are these services?"

The current files (`cloud/openai.ts`, etc.) are not services in the DDD sense. They are HTTP adapters: they take a Blob and options, hit a remote, return a Result<string, ProviderError>. They hold no state, take no DI, do not own a connection. They are pure functions wrapped in an object literal.

Honest naming options:
- `providers/transcription/openai.ts` (most accurate)
- `transcribe/openai.ts` (verb-led)
- `adapters/transcription/openai.ts` (technical accurate)
- keep `services/` (current: pragmatic, low-churn)

The agent should pick a name that matches the file's actual job and explain why.

### Frame 2: "Is the registry earning its keep?"

`TRANSCRIPTION_SERVICES` in `registry.ts` duplicates information already in `TRANSCRIPTION` in `constants/transcription.ts`. It adds: icon SVGs, `modelPathField` / `apiKeyField` names (which encode the deviceConfig keys per provider), description text. The UI uses this registry to render the provider chooser.

Question: should the registry merge into `TRANSCRIPTION` so there is one record per provider, with every UI and dispatch concern derived from that one place? What is the cost of merging? What is the cost of keeping them separate?

### Frame 3: "Is the dispatch switch a switch, or a table?"

`dispatchCloudTranscription` in `transcribe.ts` is a 6-case switch. Each case extracts provider-specific fields from `settings` and `deviceConfig`, then calls `services.transcriptions.<provider>.transcribe(audio, options)`.

The cases are structurally similar: build an `options` record from settings, call a fixed method on a fixed object. A data-driven approach would put the "how to build options for this provider" as a function on the provider's own record, then the dispatcher becomes a one-liner.

The agent should evaluate:
- Does data-driving the dispatch hide what is currently obvious?
- Does the switch tolerate per-provider weirdness better than a uniform interface?
- Where does the boundary live if not in the switch?

### Frame 4: "Cloud + self-hosted: same shape or different?"

Today: 5 cloud providers + 1 self-hosted (Speaches). Cloud providers use proprietary SDKs and proprietary error semantics. Speaches uses raw HTTP and friendly user-facing error messages because the server is user-owned.

The user-facing concept is **"any transcription provider"**: the user picks one in settings, and it transcribes their audio. The cloud/self-hosted/local distinction is plumbing.

Question: should the FE-side organization reflect the user's mental model (one list of providers) or the technical reality (different shapes)? If the latter, should it be flat or nested?

### Frame 5: "What is the smallest possible API surface?"

In the limit, a transcription pipeline is:
```
transcribe(audioRef: RecordingId | Blob, providerId: TranscriptionServiceId)
  : Promise<Result<string, AnyTaggedError>>
```

That's it. One function, one Result return. Everything else is internal.

Question: what value does the agent get from exposing per-provider service objects? Are there any callsites that benefit from holding a reference to a specific provider rather than calling through dispatch?

If the answer is "no", then the per-provider exports are vestigial. The provider implementations could be internal modules with no public-facing service objects.

### Frame 6: "Error types: shape or message?"

Each provider has its own `XxxError` defineErrors block with 3-15 variants. Pass B confirmed nothing pattern-matches on these. What survives is:
- The `.message` (rendered to the user)
- The `.cause` (sometimes carries SDK error objects)

If callsites only consume `.message`, the discriminated-union shape is over-engineering. A single `TranscriptionProviderError` with `{ provider, message, cause }` would carry the same information at a fraction of the type surface.

The counter-argument: discriminated unions are documentation in the type system. Even unconsumed, they tell future readers "here is the error taxonomy this provider can produce."

The agent should weigh these honestly.

### Frame 7: "Where does retry logic belong?"

(Not currently implemented; flag for the agent to consider.)

If transcription fails with `RateLimit` or `Connection` errors, should there be retry logic? If yes, where does it live: per-provider (because they know their rate limit etiquette), in the dispatcher (because retry semantics are app-level), or in a TanStack-Query middleware (because TQ already handles retry timing)?

The current code has no retry logic. A from-scratch design should have an opinion.

## Non-goals (out of scope for this spec)

These are explicitly excluded so the agent doesn't burn effort on them:

- Adding new providers. The spec is a refactor.
- Changing the Rust transcription path. `ModelManager` + `transcribe_recording` are settled. Local engines are done.
- Changing the recording / file storage path. `loadForCloudUpload` is a separable concern.
- Re-litigating the local engine collapse. Those three commits land.
- Building UI for new error states.

## Deliverables

The agent's output:

1. **A written architectural proposal** (markdown, in `apps/whispering/specs/`), explicitly addressing each of the 7 frames above and stating which they kept, which they discarded, and why.

2. **A concrete file layout** for the proposed end state. Show the directory tree, name each file, and one-sentence its purpose.

3. **A migration plan** in waves, each wave atomic and self-checking via `bun run typecheck`. The wave count is a hint: if it's more than 4, the proposal is likely over-reaching.

4. **An honesty section** flagging any place the proposal makes the codebase worse along some axis (e.g., more files, more imports, more cognitive overhead) and why the trade is worth it.

The agent does NOT have to implement the proposal. Stopping at written-and-reviewable is the right shape for a spec like this.

## What "good" looks like

A successful response to this spec:
- Names what it kept from the current shape and why
- Names what it changed and the asymmetric win that justifies it
- Cites specific files and line counts (current and projected)
- Refuses to do redesigns that don't pay for themselves
- Sounds like one engineer thinking out loud, not a generic architectural pattern catalog
- Defaults to deletion over abstraction when in doubt

A failed response:
- "Modernize" or "improve maintainability" without saying what gets worse
- Universal helpers (`createProvider`, `BaseService`, etc.) that flatten genuine differences
- Layers of indirection for hypothetical future needs
- Renames without clear semantic justification

---

## Handoff prompt (copy-paste to a fresh agent)

> Read `apps/whispering/specs/20260527T003910-transcription-providers-from-first-principles.md` in the epicenter repo at `/Users/braden/conductor/workspaces/epicenter/macau-v1`. Do the required reading in the order specified.
>
> Then think from first principles. You have explicit permission to question every architectural choice currently in the cloud transcription pipeline: filenames, the `services/` naming, the registry / constants split, the dispatch switch, the per-provider service objects, the per-provider error types, the cloud vs self-hosted split. The audit findings in the spec are facts you can rely on without re-verifying.
>
> Your deliverable is a written architectural proposal (one new markdown spec under `apps/whispering/specs/`), not code changes. The proposal must address each of the 7 frames in the spec, propose a concrete file layout for the end state, lay out a migration plan in atomic waves, and include an honesty section flagging where the proposal makes things worse.
>
> Constraints:
> - Do NOT touch the Rust side. `ModelManager` is settled.
> - Do NOT add new providers; this is a refactor.
> - Do NOT propose universal abstractions (`BaseService`, `createProvider`, `registerProvider`) that hide genuine per-provider differences. The audit-confirmed differences (Mistral's `.complete()`, ElevenLabs's distinct SDK shape, Speaches's friendly error messages for self-hosted UX) must survive any redesign with their reasons intact.
> - Bias toward deletion over abstraction. If a frame's answer is "the current shape is right," say so and explain why; don't invent change.
> - Match the codebase's writing voice: no em dashes, no AI-tone, concrete, opinionated.
>
> When you finish, output the path to the new spec file and a 5-bullet summary of its conclusions.
