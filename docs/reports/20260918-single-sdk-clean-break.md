# Single-SDK clean break, 2026-09-18

Proceed to separate ADR-0405 work. The three implementation checkpoints have no
remaining task-owned correctness blocker. `defineApp` was not implemented.

## Scope and decision

Task-start HEAD was `6225905ee929c8a9db90ff8ab631441a3b662ae0`, whose parent is
`271a7db0e1`. The user clarified that bespoke provider protocols are intentionally
refused. Preserving direct Deepgram and ElevenLabs functionality is therefore
not a requirement. Account isolation, explicit connection/model selection,
retention of stored values, and SQLite guarantees remain requirements.

Claude's earlier sealed-snapshot consultation informed the first slice. A
read-only straggler hunt found stale acceptance scripts and provider claims.
An independent GPT-6 design reviewer inspected raw artifacts at all three
checkpoints. Codex retained live-checkout authorship and verification.

## Reviewed implementation surface

```text
apps/
|-- epicenter/src/ai-catalog{,.test}.ts
|-- api/worker/billing/policies.ts
|-- landing/src/pages/whispering.astro
|-- vocab/src/lib/
|   |-- data.ts
|   `-- state/dictation{.svelte,.test}.ts
`-- whispering/
    |-- ARCHITECTURE.md
    `-- src/lib/
        |-- components/TranscriptionModelPicker.svelte
        |-- components/settings/README.md
        `-- constants/README.md
packages/
|-- client/src/
|   |-- connection-presets.ts, inference-errors.ts, index.ts
|   |-- openai-provider{,.test}.ts
|   `-- agent-engine.ts, connection.ts, complete{,.test}.ts,
|       transcribe{,.test}.ts [removed]
|-- constants/src/ai-providers.ts
|-- server/src/routes/transcription.ts
|-- app-shell/
|   |-- src/inference-picker/connections.svelte.ts
|   `-- scripts/inference-picker.browser.mjs
`-- app/
    |-- README.md
    `-- scripts/
        |-- shared-ai-catalog{.browser,.native}.mjs
        `-- shared-ai-catalog-native/{driver.rs,page.ts,whispering.mjs,README.md}
docs/adr/
|-- 0365-ai-owns-inference-access-and-applications-own-workflow-selection.md
`-- 0398-every-transcription-destination-speaks-the-openai-wire.md
```

The reviewers also traced unchanged App SDK ownership, browser/desktop catalog
implementations, exact selection matching, picker error presentation, workflow
operations, and their tests. This was not a repository-wide audit.

## Accepted checkpoints

1. Remove the unused raw HTTP inference implementation and obsolete desktop
   import command. Live applications already use actual App-bound OpenAI SDK
   clients. Keep the agent stream reducer, blob operations, preset data, and
   live error contracts. Retain version-1 catalog import markers as inert data;
   opening preserves exact bytes, and editing retains markers and key references
   without reading credentials. Runtime JSON import commands now fail before any
   persistence or keychain operation.
2. Own the hosted transcription model identifier once. The gateway, Cloud usage
   metadata, Whispering picker, and Vocab dictation consume
   `HOSTED_TRANSCRIPTION_MODEL`. Its value remains `whisper-1`. Billing policy,
   pricing, provider metadata, and upstream routing keep their existing owners.
3. Restore useful discovery error classification. SDK HTTP failures retain their
   status; rejected keys receive the existing key-specific message. Invalid model
   suggestions return the format error. All three discovery paths use the same
   private helper, which neither owns credentials nor changes selections.
   Removed two transcription error variants with no live producers or consumers.

The legacy raw-client tests were removed with the refused API, not because they
failed. Actual SDK workflow tests, stream tests, and blob-format tests remain.
The old successful-import test became explicit refusal and retention coverage.

| File | Tests deleted | Tests retained in file | Reason |
| --- | ---: | ---: | --- |
| `client/src/complete.test.ts` | 7 | 0 | Retired raw API; SDK completion callers and lifetime tests remain |
| `client/src/transcribe.test.ts` | 17 | 0 | Retired raw API; SDK transcription and shared format tests remain |
| `epicenter/src/ai-catalog.test.ts` | 1 | 15, plus 2 new | Import contract refused; durable values and runtime rejection now tested |

The two removed client test files total 388 lines. Their source is recoverable
from task-start HEAD. No user credential or application-data cleanup was run.

## Capabilities and stored values

Direct Deepgram and ElevenLabs requests remain unsupported. Their retained keys
cannot make those protocols usable through a custom OpenAI connection. Mistral
has no dedicated adapter or preset; a compatible custom endpoint can be entered
explicitly, but optional request fields such as `prompt` remain unverified.

App clients retain exact destinations and account lifetimes. Missing selections
do not fall back to another connection. Old product/profile settings remain
stored, unread, and unadopted. Existing account-owned configuration remains
usable. The native binding still supports its existing model-listing and
file-transcription operations, not every SDK endpoint.

No SQLite implementation changed in these slices. The App and device tests
continue to cover owner isolation, acquisition, draining, stale handles,
physical release, and failed-cleanup exclusion. ADR-0404 remains the ownership
constraint; no account adoption or storage migration was introduced.

## Verification

314 focused tests passed across disjoint suites:

- Client 27; host catalog 17; catalog routes and selections 9.
- App 161; device 53.
- Whispering completion/transcription 21; Vocab dictation 3.
- Gateway, billing policy, and hosted catalog 23.

Typechecks passed for client, constants, App browser/host targets, app-shell,
server including workers, API, Vocab, and Whispering browser/host targets.
Task-owned diffs passed `git diff --check`.

Acceptance passed:

- Chromium and WebKit: account isolation, return restoration, retired clients,
  cross-app catalog sharing, and retained legacy bytes.
- Chromium against real host routes: session/Origin checks, rejected import
  command, explicit setup, SSE, independent selections, key isolation, rotation,
  preview, deletion/reload, and catalog reopen.
- Chromium picker: pending/failed saves, hidden-key retention/removal,
  cross-window updates, retired UI, HTTP 401/403/429 messages, malformed model
  suggestions, and unchanged selections after discovery failures.
- Native macOS: real WebViews and Rust keychain, process restart, SSE reconnect,
  key replacement/removal/repair, retired access, unadopted legacy bytes, and
  three upstream cancellations on App/window/host closure. The isolated
  keychain service was empty after the run.

Native evidence:
`/private/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/shared-ai-catalog-native-QJzXoM/result.json`.
Latest picker evidence:
`/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/inference-picker-evidence-buxOuf/result.json`.

## Failures and limits

The host typecheck still fails at `account-transport.test.ts:242`: its callback
requires `owner: string`, while the contract permits an omitted owner. The same
sole diagnostic was reproduced from task-start host source and root tsconfigs
archived at `/tmp/epicenter-sdk-baseline.Zge7o1`, using the same installed
dependencies and shared packages. Neither implicated source changed here.

Earlier review reproduced both boot-test failures and the Whispering import-test
resolution failure against `271a7db0e1` and the reviewed checkout. Boot tests
expect old Session component names; current bootstrap names Shell components.
The isolated import test fails to resolve `$lib/constants/import-formats` even
though the file exists. These tests were not repaired by this cleanup. The
baseline snapshot shared installed dependencies, so this establishes the same
failures under the same dependency environment, not a historical clean install.

Native acceptance used model discovery, not real Whispering audio. The optional
`--whispering` mode, microphone capture, and authenticated vendor compatibility
were not exercised. No claim of a fully green repository-wide test suite is made.

This report records pre-commit verification. Unrelated dirty work, including
the existing runtime binding sentence in ADR-0365, was preserved and excluded
from this wave's commit.
