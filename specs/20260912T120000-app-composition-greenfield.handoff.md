# Handoff: App composition greenfield

Canonical spec: [20260912T120000-app-composition-greenfield.md](20260912T120000-app-composition-greenfield.md).
This file is a prompt to paste into a fresh session. It is not the plan; the
spec and the ADRs it cites are.

---

You are continuing work in the Epicenter monorepo at
`/Users/braden/conductor/workspaces/epicenter/yamoussoukro`, branch
`braden-w/app-schema-derive-export-import`.

## Mission

Advance the App composition greenfield described in
`specs/20260912T120000-app-composition-greenfield.md` by one shippable wave,
verified, committed with specific staged files, and reflected in the spec and
the ADRs' `Unbuilt` lines. Do not widen scope to unrelated dirty work.

## Where things stand

Accepted records: ADR-0387 (clipboard is a platform module), ADR-0388 (the
membership rule: on the App if it captures an open-time fact or close must
drain it, otherwise a platform module imported directly and selected by the
build), ADR-0389 (the open call decides the App's type; `LocalApp | AccountApp`
discriminated by `library`), ADR-0390 (the App is the unit of ownership, a
capability the unit of sharing), ADR-0391 (the build selects every
implementation; `runtime`, `ai`, `settingsKey` are to be deleted).

Shipped and committed on this branch:

- `@epicenter/app/clipboard`, the first platform module.
- `openApp` returns `LocalApp<T> | AccountApp<T>`; `captureReplica` is the
  only place that reads the library choice; a local App has no `account` or
  `retirement`.
- `AppAi.account` carries its identity; `packages/app-shell` takes `ai: AppAi`
  and has no `Pick<App` left.
- The package's host AI leaf supplies `createNativeInferenceTransport()` as
  `runtime`; Whispering's `#platform/ai` seam is deleted and it passes
  `settingsKey: 'whispering'`, which the default reproduces exactly.

Verified: `bun run --filter @epicenter/app typecheck`, `bun test
packages/app/src` (137 pass), app-shell typecheck and tests, and both
typecheck leaves of Whispering, Honeycrisp, Vocab, and local-mail. The
Whispering test suite has 25 pre-existing failures on this branch from
unrelated data-definition and module-resolution errors; none import the
changed files.

## What blocks the next wave, and why

The next wave in the spec is "the build selects everything": a
`#platform/runtime` seam in `@epicenter/app` so the default runtime is
build-selected, then deleting `runtime`, `ai`, `settingsKey`,
`ApplicationRuntime`, `AppBlobFactory`, and the `/browser` and
`/epicenter-host` exports.

It is blocked on three decisions only the user can make. Do not resolve them
by guessing; ask, or pick the part of the wave that does not depend on them.

1. **Window capability.** The desktop host runs Honeycrisp and local-mail in
   windows labeled `honeycrisp` and `mail`. Those labels match neither
   `app-*` nor `whispering`, so `trusted-app-windows-*.json` under
   `apps/epicenter/src-tauri/capabilities/` does not reach them. Desktop
   recording's `close()` (`packages/app/src/recording/desktop.ts`, the
   `current_recording` call) runs on every acquired App, so flipping the
   default runtime to desktop recording would make those windows fail on App
   close. Either those windows join the capability's `windows` array, or the
   seam waits.
2. **Storage prefix migration.** Deleting `settingsKey` moves the AI
   connections prefix for Honeycrisp (`honeycrisp`), Vocab (`vocab`), and
   Whispering (`whispering`) to their app ids. No prefix migration exists:
   `packages/app-shell/src/migrate-ai-settings.ts` renames key shapes inside
   one prefix. The desktop catalog dedupes one-time imports by
   `${appId}:${storageKey}` (`apps/epicenter/src/ai-catalog.ts`), so a renamed
   prefix re-imports and throws on any field conflict. The inference
   selections key (`${prefix}.app-ai-selections`) is a separate argument. The
   desktop host is at version 0.0.1 with no release tag; whether an installed
   base exists is the user's call.
3. **Test doubles.** Eight tests substitute sqlite and blobs through the
   `runtime` option (`packages/app/src/app.test.ts`, `recording.test.ts`,
   `apps/whispering/src/lib/whispering/app.test.ts`). Replacement options: a
   test leaf behind the seam, a seam-level `mock.module` as
   `apps/whispering/src/lib/bootstrap-failure.test.ts` already does, or
   opening the store directly.

## What you can do without those decisions

- **Platform modules wave** (ADR-0388): move download, sound, OS notification,
  platform information, and the opener from Whispering into
  `@epicenter/app/<x>` using the shape `packages/app/src/clipboard/` uses: a
  `contract.ts` with `createX(source)` normalization, a browser leaf, an
  `epicenter-host` leaf, a `#platform/<x>` seam in `packages/app/package.json`,
  and an entry in `packages/app/src/platform-selection.test.ts`. Each is a
  standalone commit. Whispering's sources: `src/lib/services/download/`,
  `src/lib/services/sound/`, `src/lib/report/os-notify.*`,
  `src/lib/platform/os.*`, and the opener inside `src/lib/tauri.tauri.ts`.
  Keep product policy (toasts, Whispering delivery outcomes) in Whispering.
- **Docs wave**: rewrite the App composition section of `docs/CONTEXT.md`,
  which still names a composition root that no longer exists and uses
  "runtime" for the opened data surface; add a "capability" entry; reconcile
  ADR-0304's desktop layout with the blob layout `apps/epicenter/src/main.ts`
  writes.

## How the direction was reached, so you do not re-derive it

- `app.clipboard` on the handle was the first proposal and was refused: the
  App's lifetime guard rejects copies before ready and after close, and UI has
  no handle to thread.
- A layered `openCore` whose result two openers spread was proposed and
  rejected on evidence: the handle is the opening store mutated in place, its
  `persistence` getter throws until acquisition, and the store's comment
  forbids spreading it; layering also splits close and ready ownership.
- An `app.account` namespace was preferred but blocked: `sync` is on the data
  document and `retirement` comes from the store opener's closure. Revisit only
  as a `@epicenter/data` decision.
- Blobs stay on the handle: `createAppBlobs` drains operations and playback
  URLs at close, and its remote half captured the account's fetch. The
  factory keyed by app and replica already exists one level down.
- `Account.authorityId` is already required; the guard was dead code.
- Sign-in adoption of local data is forbidden by ADR-0143 and ADR-0355; the
  sanctioned path is an explicit import whose shape is undecided.
- The family is called "platform module", never "device module":
  `@epicenter/device` holds App capabilities.

## Hazards

- The worktree carries the user's unrelated uncommitted work across
  `apps/api`, `apps/epicenter`, `packages/auth`, `packages/data`, several
  ADRs, and `docs/adr/0366-*` (which also holds one sentence from this
  effort). Stage specific files only. Never `git add .`, `git checkout --`,
  `git stash`, or `git reset --hard`.
- Do not run a formatter over a directory. `biome check --write` on a
  directory reformatted twelve untouched files earlier; they were restored.
  Format only the files you edited.
- `bun install` triggers a failing `install` lifecycle script in
  `apps/epicenter`; use `bun install --ignore-scripts`.
- Repo conventions: bun only; no AI attribution in commit messages; ADRs are
  one decision each, `Proposed` when written, and only the user flips them to
  `Accepted`; a spec is deleted when spent, never marked done.

## Done means

One wave landed as one or more standalone commits, each typechecking on both
leaves of every affected package, with the spec's current state and wave list
updated, the relevant ADR's `Unbuilt` line corrected, and
`bun scripts/check-doc-hygiene.ts` and `bun run check:doc-paths` reporting
nothing new for the files you touched. If a wave is blocked, the deliverable
is the smallest list of remaining decisions with the evidence for each.
