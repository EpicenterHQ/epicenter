# 0765. Choose by value, not by name; every capability has the same shape

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) at "A capability takes what it needs as values" and at its Svelte adapter "follows `fromAuth`": the value a capability takes is another capability itself, never an adapter shaped for it; the platform, the source and the job are chosen by the build or by data, never by calling a differently named function; every capability has the six-part shape below; and each `fromX` is built on one shared internal helper.
- **Amended by:** [ADR-0766](0766-an-apps-capabilities-are-module-values-opened-synchronously.md) at `openAppData` among the openers that become `openFolder(contract)`, at startup owning both roots, at the Svelte part, and at "Code chooses by value": `openFolder` replaces `openDataFolder`, `openDevice` and `openRemote`, no app opens AppData, React adapts through `useSyncExternalStore`, and a choice is a value only where it varies between call sites.; [ADR-0769](0769-svelte-reads-every-capability-through-one-reactive-copy.md) at the Svelte part and at the rejected generic adapter: no capability has a Svelte export, and `reactive(capability)` reads them all.
- **Relates:** [ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) (the rule for apps), [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) (the `tauri` export condition), [ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md) and [ADR-0759](0759-an-apps-native-shell-is-generated-on-every-build.md) (autolinked plugins), [ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md) and [ADR-0764](0764-reaching-a-model-is-epicenter-ais-alone-in-the-openai-vocabulary.md) (the endpoint array and `ModelChoice`).
- **Amended by:** [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at the `tauri` export condition picking an implementation: the package picks when it runs.
- **Unbuilt:** one `openFolder(contract)` and one `connectAccount()` picked by the build; startup owning both roots.

## Context

[ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md)
had a capability take what it needs as values and show what it can do now
as a value or `null`. It did not say how code chooses among a capability's
implementations, sources or jobs.

A three-seat composition review of the code at `08a16019ed` found that code
chose by calling differently named things:

| Choice | Made today by calling | Where |
| --- | --- | --- |
| the platform | `openDataFolder`, `openAppData`, `openDevice` or `openRemote` | `5b32f49a07:packages/folder/src/desktop-folder.ts`, `5b32f49a07:packages/folder/src/browser.ts`, `packages/folder/src/tauri.ts`, `5b32f49a07:packages/folder/src/remote.ts` |
| the platform | `createBrowserOAuth` or `createTauriAuth` | `packages/account/src/browser-oauth.ts`, `packages/account/src/tauri.ts` |
| the source | `useAccount`, `useCustom` or `useLocal` | `5b32f49a07:apps/whispering/src/lib/platform/types.ts` |
| the job | a string scope with a default written beside the read | `choices.get('tutor') ?? (canChat(HOSTED_TUTOR) ? HOSTED_TUTOR : null)` in `5b32f49a07:apps/vocab/src/lib/chat/session.svelte.ts` |

Each named pair then needed an app-level type to hold it together:
`Platform` and `VocabAuth` and `OpenConnections` in
`5b32f49a07:apps/vocab/src/lib/platform.ts`, and `Platform` and `CreateServices` in
`5b32f49a07:apps/whispering/src/lib/platform/types.ts`. The endpoint array,
`openAi([servers, learnerHosted, ...records.map(...)])` in
`5b32f49a07:apps/vocab/src/lib/ai.svelte.ts`, was the one layer already choosing by
value. Counted friction: building an app today takes about 79 to 100 names,
against 22 to 55 under the proposed shape.

## Decision

**Code chooses by value, not by name.**

| Choice | Made by | As |
| --- | --- | --- |
| the platform | the build | one name per capability; the `tauri` export condition picks its implementation ([ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md)) |
| the source | data | a `ModelChoice`, `{ endpoint, model }`, naming one endpoint in `openAi([...])` ([ADR-0764](0764-reaching-a-model-is-epicenter-ais-alone-in-the-openai-vocabulary.md)) |
| the job | data | a key such as `'chat'` or `'transcribe'`, under which the person's `ModelChoice` is kept |

App code calls no function whose name says which platform, source or job it
serves. `openDataFolder`, `openAppData` and `openDevice` become one
`openFolder(contract)`;
`createBrowserOAuth` and `createTauriAuth` become one `connectAccount()`;
`useAccount`, `useCustom` and `useLocal` become entries in the endpoint
array.

**A capability takes another capability's value, never an adapter shaped
for it.** `hosted(account)` takes the account, where
`openEndpointInference` took a `getAuthHeaders` function
([ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md)).

**Every capability has the same shape.**

| Part | Rule | Instance |
| --- | --- | --- |
| creation | created once, in the app's composition root (`app.ts`) | `export const ai = openAi([...])` |
| reads | explicit read methods, plus one `subscribe(fn)` that returns the unsubscribe | `ai.models()`, `ai.subscribe` |
| availability | a value or `null` | `localSpeech()` is `null` on the web |
| platform | every platform's implementation behind one name | `@epicenter/folder`'s `.` export, `tauri` first |
| native | an optional Rust plugin, autolinked from the dependency ([ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md), [ADR-0759](0759-an-apps-native-shell-is-generated-on-every-build.md)) | `tauri-plugin-epicenter-transcription` |
| Svelte | an optional `./svelte` export, `fromX`, built on one shared internal helper | `fromAi(ai)` in `@epicenter/ai/svelte` |

The shared helper owns subscribing while a getter is read, through
`createSubscriber` from `svelte/reactivity`, as `fromAuth` and `fromAi` each
do today. An adapter with work of its own, such as `fromClient` in
`5b32f49a07:packages/svelte/src/client.svelte.ts`, keeps that work and builds on the
helper.

## Consequences

- An app names each capability once. The app-level types that held named
  pairs together (`VocabAuth`, `OpenConnections`, `CreateServices`, and the
  pairing in each app's `Platform`) are deleted as the unbuilt items land;
  `#platform/*` keeps only what ADR-0755 leaves it, app-owned native features
  and the web sign-in callback.
- Adding a source is one more entry in the endpoint array. Adding a job is a
  new key; it adds no function to `@epicenter/ai`.
- A job key is a string, so a misspelled key reads no choice. The compiler
  catches it only where the app declares its keys as a union.
- A fix to how adapters subscribe lands in every `fromX` at once.
- Account and model choices change names to match: the account's
  `onStateChange` and `createModelChoices`' `onChange` become `subscribe`.
- A new capability is checked against the six parts; only the native
  plugin and `./svelte` are optional.

## Considered alternatives

- **A generic `ai.request(path, body)` in place of `chat`, `transcribe` and
  `embed`.** It loses each request's types and the difference between a
  stream and a single answer.
- **A reactive Proxy, or one generic `from(x)` for every adapter.**
  `fromClient` does per-item work that no generic adapter can know.
- **`endpoint({ kind })`.** It brings back choosing by name, as a string
  argument to one constructor; `hosted`, `custom`, `localServers` and
  `localSpeech` each take different values.
- **Methods generated from job names.** A job is data the person sets; a
  method per job makes data into API.
- **Folding model choices into `ai`.** `ai` would gain storage for what
  the person chose, beside reaching models.
- **An `@epicenter/app` wrapper.** Refused in ADR-0756: the composition is a
  few lines, and a wrapper grows an option per knob.
