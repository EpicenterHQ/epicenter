# Test and documentation cleanup, 2026-09-18

The five requested inconsistencies are repaired. At the verification checkpoint,
ADR-0405 remained intact and uncommitted; nothing was staged. The existing
ADR-0365 changes and all files
outside this cleanup were compared against task-start SHA-256 hashes and remain
unchanged.

The task-start inventory and tracked patch are saved at
`/tmp/epicenter-cleanup-start.status` and
`/tmp/epicenter-cleanup-start.patch`. The incremental cleanup diff, excluding
previous work, is `/tmp/epicenter-cleanup-only.patch`. This report is additional.

## Reproductions and repairs

- Vocab and Whispering each failed one boot test because it named a removed
  Session component. Their replacement tests trace the mounted route to the
  actual opening module, check the readiness gate and passed handles, and
  prohibit opening, bootstrap imports, and shell mounting in callbacks and
  their ancestor layouts. Shells must consume props without acquiring an App.
  Callback and ancestor checks now share one test; neither check was dropped.
- The isolated Whispering import suite failed before running with an unresolved
  `$lib/constants/import-formats` import. The operation and its test mocks now
  use relative module paths, including the actual `report/index.ts` entrypoint.
  The real format policy, save operation, and work-draining implementation still
  run. Both sibling-failure draining and retirement/departure tests pass with
  their assertions unchanged.
- Host runtime tests passed initially, but `typecheck:home` reproduced TS2322
  at `account-transport.test.ts:242`. The blob fixture now defaults an omitted
  owner to `no-account`, matching `src/main.ts`. Its key still includes both
  application and owner. The upload isolation test now seeds the omitted-owner
  namespace alongside another account before checking that only the captured
  account's bytes upload. The production callback contract is unchanged.
- Biome reproduced four errors. The invalid-call assertions in constant-false
  branches now live in `index.test-d.ts`, alongside the existing generic
  Account refusal. Both App typecheck targets enforce them. The recording
  fixture and browser secrets close methods assign their memoized promise
  before returning it; cleanup behavior and runtime assertions are unchanged.
- `apps/README.md` now distinguishes the Tauri host from its Bun sidecar,
  describes Local Mail's UI and Gmail backend, and names the actual host/default
  platform leaves. Bun still serves HTTP; it was not removed. ADRs 0355, 0376,
  0391, and 0404 have corrected implementation checkpoints. Their historical
  bodies and decision statuses remain intact. ADR-0403 runtime selection and
  the remaining ADR-0392 proposals were not implemented or marked complete.

## Post-implementation review

The review followed the post-implementation-review skill. The evidence included
these source and documentation paths; braces group files read together.

```text
apps/
|-- README.md
|-- epicenter/
|   |-- {AGENTS.md,package.json}
|   |-- src/{main,server,account-transport.test}.ts
|   `-- src-tauri/src/lib.rs (sidecar startup)
|-- honeycrisp/
|   |-- package.json
|   `-- src/lib/{application,data,boot-node.test}.ts
|-- vocab/
|   |-- package.json
|   |-- src/lib/{application,data,boot-node.test}.ts
|   `-- src/routes/{+page,+layout,auth/callback/+page,components/VocabShell}.svelte
|-- whispering/
|   |-- {AGENTS.md,package.json,tsconfig.json}
|   |-- src/lib/{application,bootstrap,data,boot-node.test}.ts
|   |-- src/lib/operations/{import,import.test,save-audio-recording}.ts
|   |-- src/lib/state/recording-active.svelte.ts
|   |-- src/lib/platform/runtime.{browser,epicenter-host}.ts
|   `-- src/routes/{+layout,auth/callback/+page,(app)/+layout,(app)/_components/WhisperingShell}.svelte
|-- local-mail/{README.md,package.json,ui/src/lib/application.ts,ui/src/lib/data.ts}
`-- local-books/package.json
packages/
|-- app/
|   |-- {package.json,tsconfig.json,tsconfig.epicenter-host.json}
|   |-- src/{index,index.test,index.test-d,scopes.test,recording.test}.ts
|   |-- src/platform/{browser,epicenter-host}.ts
|   `-- src/recording/desktop.test.ts
|-- app-shell/src/boot-screens/{desktop-close,desktop-close.test}.ts
`-- device/{package.json,src/browser.ts}
docs/
|-- reports/20260918-{flat-app-declaration,single-sdk-clean-break}.md
`-- adr/{0355,0369,0376,0391,0392,0398,0403,0404,0405}-*.md (status and implementation notes)
```

No new helper, wrapper, public API, or resource owner was introduced. The route
still owns startup; App owns readiness and resource closure; shells own UI
producers. The host fixture retains account namespaces. The two promise edits
retain the same promise identity. Schema inference and rejected calls remain
checked without executing invalid operations. These structural source tests
protect the current route wiring; they are not a transitive import analysis or
browser acceptance run.

No task-owned correctness finding remains. The review did not reopen declaration,
runtime-selection, storage, or credential decisions. Production schema bytes,
IDs, openers, readiness, account namespaces, and SQLite implementations were not
edited. Lower-level `defineData` remains available.

## Verification

All commands ran with Bun 1.3.14. The following passing groups are disjoint:

| Command | Tests passed |
| --- | ---: |
| `bun test apps/vocab/src/lib/boot-node.test.ts` | 4 |
| `bun test apps/whispering/src/lib/boot-node.test.ts` | 4 |
| `bun test apps/whispering/src/lib/operations/import.test.ts` | 2 |
| `bun test apps/epicenter/src/account-transport.test.ts` | 15 |
| `bun test ./packages/app/src/` | 162 |
| `bun test packages/device` | 53 |
| `bun test packages/app-shell/src/boot-screens/desktop-close.test.ts` | 2 |
| Total | 242 |

Each application suite ran in its own process. The three changed App runtime
suites also passed together, 24 tests, before the full App run.

Affected typechecks passed:

- `bun run --cwd apps/vocab typecheck`.
- `bun run --cwd apps/whispering typecheck`: browser and host.
- `bun run --cwd apps/epicenter typecheck:home`: TypeScript and Svelte.
- `bun run --cwd packages/app typecheck`: browser and host, including type tests.
- `bun run --cwd packages/device typecheck`: package and OPFS browser evidence.

Biome checked all ten changed TypeScript files with zero errors, 17 warnings,
and five informational diagnostics. The four reported errors are gone without
rule suppressions or weaker assertions. The incremental patch passes whitespace
checks.

## Remaining limits

`bun test packages/app` is a substring filter that also discovers `app-shell`.
That combined invocation had 214 passes and two failed desktop-close assertions.
`recording/desktop.test.ts` mocks Tauri core and event modules; desktop-close
expects the real modules over its window fixture. A two-file run also reproduces
incompatibility, with a missing `isTauri` export, while the exact App directory
and isolated desktop-close suite both pass. Both implicated test files are
unchanged from task start. Combined-process mock isolation remains unresolved;
use the separate commands above.

Repository-wide `git diff --check` still reports whitespace in the pre-existing
Epicenter and Whispering generated bindings. Those files are byte-for-byte
unchanged. Existing lint warnings were not converted to optional assertions.
No repository-wide green test, lint, or typecheck result is claimed.

This cleanup did not rerun browser journeys or native acceptance. Their earlier
results and remaining real-vendor/Local Mail desktop verification limits remain
in the two preceding reports. Other dirty guidance can still describe proposals
as current behavior, notably the runtime-selector sentence in Epicenter's
AGENTS.md; this cleanup preserved those user changes.
