# 0460. Vocab and Whispering are Braden Wong's apps built on Epicenter

- **Status:** Proposed
- **Date:** 2026-09-29
- **Amends:** [ADR-0246](0246-an-app-is-named-by-its-full-reverse-domain-id-everywhere-including-the-ones-epicenter-ships.md) at the prefix assigned to Whispering. Its full-ID rule remains.
- **Relates:** [ADR-0445](0445-vocab-saves-local-chats-and-syncs-saved-entries.md) (Vocab's synced entries and local chats)
- **Unbuilt:** Personal-domain homes for Vocab and Whispering; Vocab's URL, authentication, and Local chat transition; Whispering's app and store ID change, migration of data written under the current IDs, and a compatibility decision for data from the released standalone app.

## Context

`packages/constants/src/apps.ts` gives Vocab and Whispering `epicenter.so` URLs
and `so.epicenter.*` app IDs. Vocab runs as a browser SPA. Whispering's former
web deploy used `whispering.epicenter.so`, but its current native experience
runs through Epicenter desktop. Epicenter's Tauri bundle ID is `so.epicenter`.

The released standalone Whispering app used the Tauri bundle ID
`com.bradenwong.whispering`, including at the `v7.11.0` tag. Tauri used that ID
to resolve its application-data directory. The current Whispering Local
recording store is `so.epicenter.whispering`; its Personal speech-profile store
is `so.epicenter.whispering.speech`. These IDs name existing data.

The public address tells people who presents an app. A durable app ID names its
data and runtime addresses. Epicenter can provide storage, accounts, inference,
or a desktop host without becoming the publisher of every app that uses them.
Braden wants people to understand Vocab and Whispering as his apps built on
Epicenter. Whispering also has a published identifier worth retaining.

## Decision

**Vocab and Whispering present as Braden Wong's apps built on Epicenter.** Their
public homes use `bradenwong.com`; Epicenter remains named where it supplies an
account, synchronization, hosted inference, or a desktop host. A person reaches
each app directly through its public home. An app published by Epicenter or a
third party follows its own publisher's public home.

| App | Public home | Durable app identity |
| --- | --- | --- |
| Vocab | `vocab.bradenwong.com` serves the browser app; `bradenwong.com` introduces and links to it. | The current `so.epicenter.vocab` app ID stays. Moving a web address does not itself rename existing data. |
| Whispering | `whispering.bradenwong.com` introduces the app and explains how to get its available build. | The app ID becomes `com.bradenwong.whispering`, the ID of the released standalone bundle. |

Whispering uses `com.bradenwong.whispering` in its application catalog, routes,
deep links, and window identity under ADR-0246. Its Local recording store uses
that ID, and its Personal speech-profile store uses
`com.bradenwong.whispering.speech`. Epicenter's Tauri bundle stays
`so.epicenter` while hosting Whispering. A future standalone Whispering shell
uses `com.bradenwong.whispering` as its Tauri bundle ID.

The Whispering ID change ships only with an explicit treatment of current
Local recordings and Personal speech-profile data under the `so.epicenter.*`
IDs. The implementation also decides whether and how to read compatible data
from the released standalone app's `com.bradenwong.whispering` directory.
Reusing that bundle ID does not make an old data format readable by a new build.

Moving Vocab's URL needs a separate treatment of device-local chats and
choices. A redirect from `vocab.epicenter.so` cannot move browser storage to
`vocab.bradenwong.com`. Before moving existing learners, the implementation
preserves those chats or tells them clearly that the chats remain at the old
origin.

## Consequences

- Vocab and Whispering have direct entrances and a public identity that names
  Braden as their publisher while explaining Epicenter's service role. A
  Whispering product page does not itself create a second hosted SPA or native
  bundle.
- Vocab's app ID stays stable, but its URL and authentication callbacks change.
  Local browser data needs a preservation decision before the origin changes.
- Whispering's current Local and Personal data need a migration or stated
  preservation path before the new IDs replace the live ones. A future
  standalone release can reuse the old OS-level identity without renaming
  Epicenter's host.
- ADR-0246 still requires one full app ID everywhere. Its `so.epicenter.*`
  prefix no longer applies to Whispering.

## Considered alternatives

- Keep both public homes under `epicenter.so`. The address would present them
  as Epicenter products despite their intended publisher identity.
- Put every app in this repository under `bradenwong.com`. Repository membership
  does not decide who publishes every present or future app.
- Keep `so.epicenter.whispering` as Whispering's permanent app ID. That avoids
  an ID migration, but a future standalone build could reuse the old bundle
  ID only while keeping a different internal app ID.
- Rename Epicenter's desktop bundle to `com.bradenwong.whispering`. That names
  a host for multiple apps after one product and moves Epicenter's own
  app-data location.
