# 0753. An app declares what it is and what it needs; the platform supplies where, how and when

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md) above its principles, without changing their text: the principles serve one rule, that an app declares what it is and what it needs and the platform supplies where, how and when.
- **Amended by:** [ADR-0759](0759-an-apps-native-shell-is-generated-on-every-build.md) at "in `native/`": app-specific native code lives in `modules/<name>/`; [ADR-0760](0760-global-shortcuts-are-a-capability.md) at "Whispering's global shortcut is one": global shortcuts are the capability `@epicenter/shortcut`; [ADR-0766](0766-an-apps-capabilities-are-module-values-opened-synchronously.md) at "What it needs": the capabilities are module values exported from `src/lib/app.ts`, and where a capability keeps its per-computer state is the platform's answer.
- **Relates:** [ADR-0723](0723-an-apps-site-is-found-by-convention.md) (an app is a site that publishes its contract), [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) (where), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (when), [ADR-0751](0751-every-native-app-carries-one-sync-core.md) (the core every native implementation links), [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) (how an app composes what it needs), [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) (how the build picks an implementation), [ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md) (the app's layout), [ADR-0749](0749-epicenter-draws-its-boundaries-where-people-already-expect-them.md) (boundaries where people expect them).
- **Amended by:** [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at "the implementation the build picks": the package picks when it runs.
- **Unbuilt:** an `app.ts` in any app; a phone implementation of any capability; the build choosing every capability's implementation ([ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md)).

## Context

Whispering answers most platform questions in its own code today. Its
`package.json` maps four seams, `#platform/auth`, `#platform/root`,
`#platform/services`, and `#platform/variant`, each to a `tauri` leaf and a
`default` leaf. Its desktop capability file
(`programs/whispering/src-tauri/capabilities/whispering.json`) lets the page ask
Epicenter to sync its folder through `epicenter://init`. A script,
`programs/whispering/scripts/write-contract.ts`, writes its contract to
`static/contract.json`.

Three records on 2026-11-04 each took one of those answers out of the app.
[ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md)
puts an app's folder under the root the platform shows a person.
[ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md)
runs sync at moments the shell sees, and app code calls no sync function.
[ADR-0751](0751-every-native-app-carries-one-sync-core.md) puts one core in
every native program. Together they leave an app's own code with two jobs:
saying what the app is, and saying what it needs.

A phone is the test of that split. If a phone app needs its own version of
the app's code, the platform has not taken over. The sync core now builds for
iOS (branch `claude/spike-sync-core-ios`, commit `1f834dc23b`): with git2
built without OpenSSL it compiles for `aarch64-apple-ios` and
`aarch64-apple-ios-sim`, passes every native round test, and links at 2.56 MB
(5.77 MB with OpenSSL). A Rust transport registered for `https` through
`git2::transport::register` carries a whole round
<!-- doc-path-check: ignore-next-line -->
(`packages/sync-core/tests/transport.rs` on that branch).

## Decision

**An app declares what it is and what it needs; the platform supplies where,
how and when.**

| Question | Answered by | With | Record |
| --- | --- | --- | --- |
| What it is | the app | its contract (`contract.ts`, published as `/contract.json`) and its site | [ADR-0723](0723-an-apps-site-is-found-by-convention.md), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) |
| What it needs | the app | capabilities composed in its `app.ts`: `folder`, `account`, `recorder`, `ai`, `transcription` | [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) |
| Where | the platform | the visible root: `~/Epicenter` on a computer, the app's container on a phone | [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) |
| How | the platform | the implementation the build picks for each capability: desktop, phone, or web | [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) |
| When | the platform | the sync moments: open, a few seconds after a save, return to the window, Sync | [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) |

**An app's code names no path, no platform, and no sync moment.** A phone
is another implementation of the same capabilities, not another app.

**[ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md)'s
principles serve this rule.** A change is checked against the rule before
the principles: a change that makes an app name a path, branch on a platform,
or choose when to sync moves a platform answer into the app, and names why.

## Consequences

- Supporting a platform means implementing each capability and naming its
  root there. Whispering on iOS is Whispering's `app.ts` built for iOS.
- A capability with no implementation on a platform is `null` there
  ([ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md)),
  and every app that uses it handles `null`.
- A platform difference that a capability hides, such as Android's choice
  between the app's own storage and a granted folder, is decided once in the
  capability, and no app can decide it differently.
- A feature no capability covers stays the app's own, per platform, in
  `native/`
  ([ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md)).
  Whispering's global shortcut is one.
- Each of Whispering's `#platform/*` seams either becomes a capability's
  implementation or names the app-owned feature it serves
  ([ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md)).

## Considered alternatives

- **Each app answers where, how and when (today's per-app `#platform/*`
  seams).** Every app repeats the same platform split, and a phone means
  editing every app.
- **A runtime object an app asks which platform it is on.** App code then
  branches on the platform, and each branch is a place a phone build can
  differ.
- **A framework package that answers both what an app needs and how
  (`@epicenter/app`).** Refused in
  [ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md):
  the composition is a few lines, and a wrapper grows an option per knob.
