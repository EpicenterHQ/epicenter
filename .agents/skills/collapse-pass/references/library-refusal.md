# Library refusal as information

Use friction at a library boundary as evidence about the proposed model.

When a library refuses your model, the refusal is information about the model,
not friction to route around.

## The rule

When a library refuses your model, investigate the mismatch before building
machinery to work around it.

Read the library's public surface before reshaping or reimplementing its types,
lifecycle, observers, or options. Remove local machinery that duplicates the
library without adding useful behavior or a necessary boundary. Keep a local
model when the work requires responsibilities the library does not own.

## Why this rule earns its keep

A library's public surface defines the behavior it supports, including details
a local wrapper can silently omit. Its documentation and installed source
establish that contract; they do not decide which model the product needs.

Yjs has thought about CRDT replicas. ArkType has thought about runtime
validation. Better Auth has thought about session lifecycle. Drizzle has
thought about query composition. Read those decisions before building a second
version of the protocol; their authority over that protocol does not require
the product to adopt every part of the library's model.

When a helper recreates part of a library protocol, investigate two costs:

1. Behavior the local shape drops or changes.
2. A second protocol that must stay aligned as the library changes.

The first symptom is duplication. The second symptom is silent feature loss.
Check which supported cases the local shape drops and how it will stay aligned
as the library changes.

An intentionally narrower domain API can still earn its place. Name what that
boundary gives its callers and compare the complete result.

## How to apply the rule during a pass

When a finding proposes a simplification that touches a library boundary, before editing:

1. Read the installed public types and source for the behavior being changed.
2. Confirm decisive details in official documentation or upstream source. Use
   the relevant domain skill and DeepWiki when helpful; check the installed
   version before relying on an upstream example.
3. Compare the proposed boundary with using the library directly. If it only
   recreates an existing protocol, remove that duplication.
4. If the boundary owns a domain rule, lifecycle, or useful contract, name it
   and adapt explicitly where the two models meet. If the library cannot
   support a necessary capability, compare changing or replacing the dependency
   with maintaining the workaround.

Name the invariant, domain rule, lifecycle, or useful contract in one sentence.
If the local model adds none, prefer the library's existing surface over a
second protocol. Cite the specific function or type that already does the work
the custom shape was doing. An intentionally narrower API can still earn its
place when that sentence explains what its callers gain.

## Upstream starting points

Choose the source for the dependency the affected code actually uses. Verify
the package and installed version first; these are lookup leads, including
ones relevant to earlier subsystems, not a fixed inventory of current
dependencies or a reason to introduce a library.

| Upstream repository | Concern to investigate |
|---|---|
| `arktypeio/arktype` | Runtime validators, schema composition, and branded types. |
| `yjs/yjs` | CRDT types, observer lifetimes, transactions, and subdocument identities when the affected source uses Yjs. |
| `yjs/y-indexeddb` | Browser persistence and its lifecycle when that adapter is present. |
| `standard-schema/standard-schema` | The shared contract between validator libraries and their consumers. |
| `sveltejs/svelte` and `sveltejs/kit` | Runes, stores, component lifetimes, routing, and adapters. |
| `honojs/hono` | HTTP routing, middleware composition, and error handling. |
| `better-auth/better-auth` | Session, plugin, and adapter contracts. |
| `drizzle-team/drizzle-orm` | Schema, query, and migration contracts. |
| `huntabyte/shadcn-svelte` and `ieedan/shadcn-svelte-extras` | UI primitive composition; compare with the local component source and overlay. |
| `useautumn/autumn` | Hosted billing primitives. |
| `jsrepojs/jsrepo` | Installable-block packaging. |
| `TanStack/query`, `TanStack/table`, and `TanStack/ai` | The options, observers, data contracts, and framework adapters of the family actually in use. |

The relevant domain skill supplies more specific source checks. Verify
version-dependent details such as projection syntax rather than carry them
forward from an older example.

## What a library refusal looks like

Concrete shapes to investigate before extending a local model:

- You are about to write a custom `Observer`-like type because the existing object "doesn't quite fit." The library already ships an observer.
- You are about to extract a `*Manager` to wrap a library client's session, but the library already owns the session and provides the lifecycle hook you need.
- You are about to copy a library's type into your own package "to remove the dependency" from a leaf module. The leaf module imports the library implicitly anyway; the copy just hides it.
- You are about to add an option named for an implementation step (`refreshFn`, `decryptCallback`). Check whether the library's policy-shaped option (`refresh`, `decrypt`) already expresses the behavior the caller needs.

For each candidate, establish which responsibility the boundary adds. Remove
duplicated protocols, preserve justified domain boundaries, and verify the
required behavior through the resulting callers.
