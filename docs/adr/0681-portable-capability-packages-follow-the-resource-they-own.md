# 0681. Portable capability packages follow the resource they own

- **Status:** Proposed
- **Date:** 2026-10-22
- **Relates:** [ADR-0403](0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md) established runtime selection inside the former App package; [ADR-0636](0636-an-app-opens-local-files-through-one-folder-handle.md) and [ADR-0643](0643-the-folder-package-owns-its-local-engine.md) establish Folder's public contract and implementation owner; [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) keeps inference independent of local data; [ADR-0673](0673-a-sqlite-handle-owns-one-connection-until-asynchronous-disposal.md) and [ADR-0678](0678-app-storage-openers-use-runtime-bound-scopes.md) define the accepted, unbuilt database contract.
- **Unbuilt:** `@epicenter/sqlite` and `@epicenter/secrets` have no production exports. The browser SQLite backend and native secret-store adapter remain undecided.

## Context

`@epicenter/folder` lets an app open authored files through one contract in a browser or a native window. The accepted database design opens a named private SQLite database in an installation-bound scope. Apps also need credentials: the CLI already has a small `get`/`set`/`delete` store over `Bun.secrets`, while browser and desktop apps currently keep or use credentials through their own adapters. Hosted inference has its own network, account, and request lifetime and already exposes `openEpicenterInference({ account })` from `@epicenter/ai`.

These capabilities can all be used from more than one runtime. That property alone does not give them one owner. A single package named for the platform would grow whenever another portable operation appears, whether or not its dependency graph, authority, failures, or lifetime belongs with the earlier operations.

## Decision

**Name a public package for the resource and contract it owns, not for the fact that it runs on several platforms.**

| Capability | Package home | Owner and boundary |
| --- | --- | --- |
| Authored files, tables, and Git-backed exchange | `@epicenter/folder` | One opened Folder and its rooted files; the browser or native shell supplies the location. |
| App-managed private SQLite databases | `@epicenter/sqlite` | Named databases in an installation scope, with SQL and connection cleanup. The app owns schemas, migrations, and rebuild policy. |
| App-owned secret values | `@epicenter/secrets` | Named values under a runtime-bound application scope. Its adapters may use browser storage, an operating-system credential store, or Bun's credential API; the contract must state their different protection and persistence properties. |
| Inference, including Epicenter's hosted service | `@epicenter/ai` | An explicitly chosen inference destination and request lifetime, with account authorization for the hosted service. It has no Folder or installation-private database lifetime. |

**SQLite and secrets have separate package lifetimes and imports.** A database retains one connection and closes asynchronously. A secret-store operation needs no connection or matching close. Neither package absorbs Folder, inference, clipboard, recording, or every later native feature. An installation binding in Rust may support several capabilities without requiring one JavaScript package to own them all.

`@epicenter/sqlite` is the app-facing named-database capability. It does not restore the former `@epicenter/sqlite/bun-mirror` helper removed by [ADR-0247](0247-an-app-that-keeps-a-local-copy-of-a-providers-data-owns-its-file-lifecycle.md). Apps still own the lifecycle of the data inside their databases.

**A portable entry selects its adapter inside the capability when the runtime is known.** For an opener such as `openFolder`, selection happens when called, not when imported. A native refusal never silently opens browser storage. A package may offer explicit browser, Tauri, or Bun entries when a consumer needs a single-runtime build or a tool must supply its scope. Not every package needs every entry: inference already receives an `Account` or endpoint explicitly. A Tauri page does not choose an AppData root, keychain service, or another application's identity merely by supplying a string; the shell binds its authority before exposing a native operation. A Bun tool can supply an explicit root or service at its composition boundary.

**Add to an existing package only when the operation belongs to its resource contract.** A new package needs a real caller, a distinct owner and invariant, and failures, lifetime, or dependencies that do not belong in an existing package. The package home can be decided before implementation; create the package when its first real caller uses it. A private-file API, local settings wrapper, or universal device handle is not added in anticipation of possible callers.

ADR-0673 and ADR-0678 still name `openDeviceDatabase` and `deleteDeviceDatabase`; this package decision does not rename them or change their signatures. The secret-store contract, native adapter, browser persistence choice, and treatment of host-owned credentials need their own decision before `@epicenter/secrets` ships. A browser storage adapter must not claim the operating system credential store's protection.

## Consequences

- App code imports the capability it uses. Cross-platform behavior is a promise of that capability, not a reason to depend on an umbrella runtime.
- An app that only uses Folder need not acquire a database or a credential store. Inference can compose credentials when its chosen destination requires them, without making their storage part of Folder or the inference handle's ownership.
- Hosted inference can change its service endpoint, authorization, or billing without changing local storage APIs. Its current `openEpicenterInference({ account })` remains in `@epicenter/ai`.
- `@epicenter/device` is not created solely to group SQLite and secrets. "Device" could mean capture hardware, a physical machine, an app installation, or an origin; those are not interchangeable scopes. Operating-system credential migration or roaming also makes physical-device language too strong for a secret-storage guarantee.
- Existing CLI-owned AI keys are not silently moved into an app-owned secret namespace. Sharing or migrating them requires an explicit owner and access decision.

## Considered alternatives

- **`@epicenter/device`.** It groups operations by their local runtime rather than by one resource contract. Database connections and credential values have different lifetime, backend, and access rules; hosted and standalone installations can be distinct even on one physical device.
- **`@epicenter/platform` or `@epicenter/runtime`.** Every portable capability could qualify, so neither name says what belongs or keeps an unrelated dependency out. A runtime object would also restore one acquisition lifetime for independent resources.
- **`@epicenter/api`.** This does not distinguish a local library from Epicenter's hosted HTTP API and gives no rule for admitting Folder, SQLite, secrets, or inference.
- **Re-export every capability from one umbrella entry.** It makes the first import convenient but hides each resource's authority and dependency closure. A convenience entry could be considered only for a concrete caller whose build and ownership remain clear.
