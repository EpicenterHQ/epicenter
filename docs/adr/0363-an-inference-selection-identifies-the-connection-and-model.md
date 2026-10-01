# 0363. An inference selection identifies the connection and model

- **Status:** Proposed
- **Date:** 2026-09-08
- **Revised:** 2026-09-20
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

The current value shape is `{ connectionId, model }`. Whispering stores its completion and transcription choices in device KV. Vocab
chat keys its local selection store by conversation ID. Each application chooses
its persistence shape and any initial default. The App's
connection surface provides connections and catalog management; it stores no
workflow selection.

The settled experience shares custom connections across desktop apps while
standalone browser catalogs remain origin-local. Selection ownership stays
with each product in both environments: changing Vocab's model must not change
Whispering's choice. Catalog sharing does not introduce a global workflow
default or require applications to use the same connection.

Whispering declares nullable connection keys beside its model keys in device
KV. Picker callbacks write both fields in one update. Reads use the same reactive
KV API as other settings. The captured account owns that device namespace.

Chat retains a device-local target per conversation in the browser selection
store. Its conversation model is synced data, so the chat owner rejects a local
target whose model differs from the current conversation model. A new device
must choose a connection explicitly. The shared picker takes `catalog`, `value`,
and `onSelect`; it knows neither storage format nor workflow scope.

**A saved reference identifies a concrete destination.**

Custom connections use generated immutable IDs, not URLs or array positions.
Account references identify the captured authority and principal. Native
runtime references identify the supplied runtime destination. The current
encodings are `account:` plus the JSON authority/principal pair and `runtime:`
plus the client's base URL, so the id says which scope owns the connection
without a second field. Moving selection ownership preserves these values;
changing their representation is not necessary for this boundary change.

The SDK client is an in-memory capability, never persisted selection data.
Endpoint URLs and credentials stay in the device's connection settings. A saved
runtime reference is device-scoped; it does not grant another device access to
that runtime.

**Resolution requires the exact saved destination and the model saved with it.**

The saved pair is the resolver's whole input. `resolveInferenceTarget` in
`packages/app-shell/src/inference-target.ts` returns `{ client, model, source }`
or null for a missing destination or blank model. The catalog observes connection
changes and delegates to that resolver. Chat applies its synced-model comparison
before resolution; Whispering reads its pair directly. Discovery supplies no
fallback destination.

Changing Accounts cannot reinterpret A's saved selection as B. Removing a
custom connection leaves its reference unavailable; recreating the same URL
gets a different ID and cannot revive that choice. The application may retain
the unavailable reference to explain what needs reselection.

**Discovery supplies suggestions, not permission to use a model.**

A manually entered model remains addressable when discovery is empty or fails.
Refreshing an inventory does not erase a choice. Presets allow optional bearer
credentials because their endpoints are editable. Connection order does not
determine execution or billing.

**Each run captures its connection and model before sending data.**

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
must agree; `canServe` can establish a matching connection, not endpoint
reachability or support for an operation.

## Consequences

The same model ID can be selected independently on several servers. A second
device may need a local selection before continuing a synchronized conversation.
An unavailable endpoint can fail a request but cannot redirect it.

Connection access remains useful without a workflow store. Applications that
already hold a connection can call it directly. Applications with remembered
choices share one matching function and keep their product defaults explicit.

Whispering imports matching choices from its previous browser selection store
before starting recording and queries. Undefined connection keys admit the
import; explicit null records initialization or reset. The import retains
unavailable IDs, refuses mismatched models, and leaves legacy bytes untouched
so a pending KV persistence write cannot destroy the source. It installs no
ongoing legacy observer.

## Considered alternatives

- Prefer custom servers on model-name collisions: choosing a group cannot reliably select a destination, and removing a server changes routing.
- Put scope-indexed selection on the App's connection surface: makes a connection capability own application workflow settings.
- Keep independent resolvers in UI and operations: permits destination validation and actual execution to disagree.
- Sync endpoint URLs and keys with conversations: moves device configuration into shared data and gives localhost the wrong meaning elsewhere.
- Keep a global preferred server per model: prevents two conversations from choosing different servers for the same model.
- Delete every unavailable reference: loses information useful for explaining a missing choice; stable IDs already prevent accidental resurrection.

## Implementation

`packages/app-shell/src/inference-target.ts` owns exact resolution.
`inference-picker/catalog.svelte.ts` observes connections and discovers models.
Whispering reads and writes declared device KV fields; agent-chat owns local
conversation targets and their comparison with synced model metadata.

Tests cover identity isolation, removed connections, blank models, captured
operations, retirement, migration, reset, and reopening. The browser picker
harness covers pending and failed saves, cross-window changes, and late
selection suppression after closing or replacing the catalog.
