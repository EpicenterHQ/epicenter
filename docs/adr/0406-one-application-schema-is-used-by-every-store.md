# 0406. One application schema is used by every store

- **Status:** Accepted
- **Date:** 2026-09-18
- **Relates:** [ADR-0405](0405-one-flat-application-declaration-opens-the-live-app.md) for declaration shape; [ADR-0404](0404-the-opened-account-owns-application-local-storage.md) for local ownership.

## Context

ADR-0392 proposed declaring device data separately so a device preference
could not be written into an account store. The current implementation instead
instantiates one definition across device, Personal, and Shared. Account-owned
local storage makes ownership explicit without requiring different schemas.

A field's shape does not decide whether its value synchronizes. The selected
store already decides that.

## Decision

**One application's `kv` and `tables` declarations apply to every store it opens.**

There is no separate device-definition API. Every store exposes the same typed
keys and tables, while holding independent values and rows:

| Store | Owner | Synchronization |
| --- | --- | --- |
| `app.device` after `open()` | No account, within this app and device profile | None |
| `app.device` after `open(alice)` | Alice, within this app and device profile | None |
| `app.account.personal` | The captured account | Personal library sync |
| `app.account.shared` when available | The deployment's Shared library, accessed through the captured account | Shared library sync |

**Application code chooses a value's destination when it writes.**

Using the declaration in ADR-0405, after readiness:

```ts
const app = notes.open(alice);
app.device.kv.update({ microphoneId: 'built-in' });
app.account.personal.kv.update({ preferredLanguage: 'en' });
```

A microphone selection can remain on this device while a language preference
follows the person. Those placements are application policy, not restrictions
encoded in separate schemas. The same key may intentionally hold independent
values in different stores. Reads name a store too; the framework does not
merge values, copy them on sign-in, or fall back between stores automatically.

## Consequences

The proposed separate device declaration is removed from the implementation
plan. Applications can consolidate their separate settings persistence into
existing stores without adding another schema system.

TypeScript validates keys and values, but does not reject a device-bound key
written to Personal. Applications own placement and test behavior where an
incorrect destination would matter. Sharing the schema does not require every
store to contain every declared key or any rows in every table.

This decision does not migrate existing settings or assign old shared local
values to an account. A settings migration must establish the intended owner
and destination before transferring existing values.

## Considered alternatives

- **Separate device and account definitions.** Adds declaration and consumer
  type complexity to enforce placement that applications can own directly.
- **Annotate each field with a destination.** Makes one placement mandatory
  even where separate local and synchronized values are useful.
- **Merge device and Personal settings on read.** Hides the selected store and
  requires precedence and write-routing rules that explicit access avoids.
