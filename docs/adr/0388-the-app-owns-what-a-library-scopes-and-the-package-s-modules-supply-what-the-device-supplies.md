# 0388. The App owns what a library scopes, and the package's modules supply what the device supplies

- **Status:** Accepted
- **Date:** 2026-09-12
- **Amended by:** [ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md) at the spelling of App-capability access: a capability reads under the scope that owns it, so the table's `app.x` is `app.device.sqlite`, `app.device.secrets`, and `app.account?.personal.blobs`. The membership test and the platform-module family stand.
- **Amended by:** [ADR-0403](0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md) at the selector only: a platform module is selected by the package at runtime, not by the build condition. The membership rule, the family name, and the two-leaf shape stand.
- **Unbuilt:** Download, OS notification, platform information, and opening URLs as `@epicenter/app` platform modules. Sound is withdrawn from the list: it has no platform split and carries Whispering's own cues, so it stays a Whispering service. The rule is written here and applied to the clipboard only; Whispering still holds download and sound in its `services` barrel, OS notification under `report/`, and platform information and the opener in its Tauri namespace file.

## Context

Whispering owned every platform capability, behind its `services` barrel, its
`#platform/*` seams, and its Tauri namespace file. Other applications had
nothing to reach for. As those capabilities move into `@epicenter/app` so
every application shares them, each one needs a home, and the home has been
decided by taste: recording landed on the opened App, and the clipboard was
first proposed there too.

An inventory of the opened App found one rule already in force but never
written. Every member that captures identity or owns a resource is also
guarded by the App lifetime and drained by `close()`: the declared data
surface (`tables`, `kv`, `transact`, `stored`, `rowFile`, `onCommitted`,
`pressure`, `stateVector`, `encodeStateSince`, `persistence`, `sync`) and the
composed capabilities (`blobs`, `sqlite`, `secrets`, `recording`, `ai`). The
only unguarded members are inert facts (`appId`, `dataId`, `account`,
`definition`) and lifetime handles (`ready`, `signal`, `retirement`, `close`).

## Decision

**A capability joins the opened App when it captures something `open()` fixed
or has work `close()` must drain; otherwise it is a platform module of
`@epicenter/app`, imported directly and selected for the build.**

An open-time fact is the application, library, replica, account, or
transport. A platform module captures nothing, is meaningful before any App
opens and after every App closes, and is selected by a `#platform/*` seam
inside the package.

| Family | Membership test | Access |
| --- | --- | --- |
| App capability | captures an open-time fact, or close must drain it | `app.x` |
| Platform module | captures nothing; works with no App | `import { x } from '@epicenter/app/x'` |
| Product-native | no browser meaning; needs accessibility, foreground focus, or another window | stays in the product behind its own seam |
| UI chrome | Svelte | `@epicenter/app-shell/x` |

The close obligation is the tiebreaker in both directions. It keeps the
clipboard off the App. It keeps `app.ai` on the App even though its custom
connections are device-local storage and its runtime transport is the host's:
both hold live SDK clients whose in-flight bodies must abort when the App
closes.

A platform module has a real browser leaf or an explicit absence in the
default leaf. A capability with no general meaning stays with the product that
needs it; a second application wanting it is what promotes it, not an
intention.

"Platform module" is the family's one name. It is not "device module":
`@epicenter/device` supplies SQLite and secrets, which are App capabilities
under this rule, so that word would point at the wrong family.

The package keeps the name `@epicenter/app`. It is what an Epicenter
application composes, and both families read under it: `@epicenter/app` is
the App, `@epicenter/app/clipboard` is the platform the app runs on.

## Consequences

- Clipboard, download, sound, OS notification, platform information, and
  opening URLs are platform modules. Cursor delivery, simulated keystrokes,
  global shortcuts, overlay windows, and autostart stay Whispering's.
- No platform module has a lifecycle test, because it has no lifecycle.
- Presentation code and boot screens reach the platform without an App.
- A `runtime` field on the App for a platform module is refused; the build
  condition is the only selector for one.
- `docs/CONTEXT.md` names the opened data surface a store and carries the
  App hub, device scope, and account scope entries; nothing there still
  describes a composition root.

## Considered alternatives

- **Every shared capability on the App.** One handle to learn, but the App's
  lifetime guard rejects a copy before `app.ready` and after `close()`, and
  `packages/ui` and boot screens have no App to thread. Refused.
- **A `platform` barrel grouping the modules.** Re-creates Whispering's
  `services` barrel one level up. Per-module exports keep each seam's leaves
  visible in `package.json`. Refused.
- **Renaming the package `@epicenter/api`.** `apps/api` is the hosted Worker
  and `@epicenter/client` is its HTTP client; a third claim on the word buys
  nothing. Refused.
