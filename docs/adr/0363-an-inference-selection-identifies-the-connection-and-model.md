# 0363. An inference selection identifies the connection and model

- **Status:** Proposed
- **Date:** 2026-09-08
- **Revised:** 2026-09-10
- **Amends:** [ADR-0059](0059-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md) and [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) at model resolution: explicit device-local selections replace discovery-based, custom-first routing.

## Context

The shared picker once committed only a model ID. The registry then chose the
first custom connection advertising that ID, followed by hosted inference.
Choosing a different group could execute against the same server. Removing a
connection could redirect the next request.

Callers began saving a connection-and-model pair alongside core connection
settings. The Svelte picker and Whispering operations matched it to clients
separately. The selection describes product intent, so its ownership belongs
above the core connection API.

## Decision

**The application owns an explicit device-local connection and model pair for
each workflow that needs a remembered choice.**

The current value shape is `{ connectionId, model }`. Whispering uses
`completion` and `transcription` scopes. Vocab chat uses the conversation ID.
The application chooses these scopes and any initial default. Core AI provides
clients and custom connection management; it stores no workflow selection.

The settled experience shares custom connections across desktop apps while
standalone browser catalogs remain origin-local. Selection ownership stays
with each product in both environments: changing Vocab's model must not change
Whispering's choice. Catalog sharing does not introduce a global workflow
default or require applications to use the same connection.

A shared plain TypeScript owner outside `@epicenter/app` may handle persistence,
observation, and exact matching. The page owns its lifetime. UI and product
operations use the same owner so they agree on the destination. Svelte adapts
observation without becoming the owner of routing policy.

**A saved reference identifies a concrete destination.**

Custom connections use generated immutable IDs, not URLs or array positions.
Account references identify the captured authority and principal. Runtime
references identify the supplied runtime destination. The current encodings are
`account:` plus the JSON authority/principal pair and `runtime:` plus the
client's base URL. Moving selection ownership preserves these values; changing
their representation is not necessary for this boundary change.

The SDK client is an in-memory capability, never persisted selection data.
Endpoint URLs and credentials stay in local connection settings. A saved
runtime reference is also device-local; it does not grant another device access
to that runtime.

**Resolution requires the exact saved destination and the workflow's expected model.**

Where a model preference is synchronized separately, the application compares it
with the saved local selection before execution. A missing selection, changed
model, absent capability, or removed connection produces no client. The UI asks
for an explicit choice. Discovery never supplies a fallback destination.

Changing Accounts cannot reinterpret A's saved selection as B. Removing a
custom connection leaves its reference unavailable; recreating the same URL
gets a different ID and cannot revive that choice. The application may retain
the unavailable reference to explain what needs reselection.

**Discovery supplies suggestions, not permission to use a model.**

A manually entered model remains addressable when discovery is empty or fails.
Refreshing an inventory does not erase a choice. Presets allow optional bearer
credentials because their endpoints are editable. Connection order does not
determine execution or billing.

**Each run captures its client and model before sending data.**

Chat reuses that pair across tool steps. A later run can read the current
selection. New conversations copy an explicit current target when the product
calls for it; any initial account default is deliberately saved by the app.
Existing or synchronized conversations without a local target require a choice
on that device.

Whispering's transcription, Polish, and Recipes preserve their respective
selection rules. Vocab dictation keeps its deliberate account client and
transcription model independent of chat selection. Sharing a helper does not
require every workflow to acquire a persisted selector.

Previous provider settings can seed an explicit user choice. They cannot act as
a fallback when the current selection is missing. UI validation and execution
must agree; `canServe` can establish a matching client, not endpoint reachability
or support for an operation.

## Consequences

The same model ID can be selected independently on several servers. A second
device may need a local selection before continuing a synchronized conversation.
An unavailable endpoint can fail a request but cannot redirect it.

Connection access remains useful without a workflow store. Applications that
already have a client can call it directly. Applications with remembered choices
share matching logic above core AI and keep their product defaults explicit.

The old combined `${settingsKey}.app-ai` envelope is imported into separately
owned live stores under one initialization lock. Conversion preserves IDs, keys,
choices, and unresolved references. A failed conversion preserves successful
destination writes and the source for retry. No live owner rewrites the old
envelope. ADR-0365 records the storage boundary.

## Considered alternatives

- Prefer custom servers on model-name collisions: choosing a group cannot reliably select a destination, and removing a server changes routing.
- Put scope-indexed selection in core AI: makes a connection capability own application workflow settings.
- Keep independent resolvers in UI and operations: permits destination validation and actual execution to disagree.
- Sync endpoint URLs and keys with conversations: moves device configuration into shared data and gives localhost the wrong meaning elsewhere.
- Keep a global preferred server per model: prevents two conversations from choosing different servers for the same model.
- Delete every unavailable reference: loses information useful for explaining a missing choice; stable IDs already prevent accidental resurrection.

## Implementation

`packages/app-shell/src/inference-selections.ts` owns selection persistence and
exact matching. Whispering operations and the Svelte picker use that same path.
`migrate-ai-settings.ts` converts saved settings before the page exposes either
owner. Storage, bootstrap failure, and real-browser tests verify conversion,
retirement, reload, and refusal to redirect a missing choice.
