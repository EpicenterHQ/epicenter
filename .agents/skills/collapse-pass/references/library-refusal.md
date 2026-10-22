# Library Refusal as Information

The principle that decides hard cases inside a collapse pass.

## The rule

When a library refuses your model, the refusal is information about the model, not friction to route around.

If a "simplification" requires reimplementing a library's public surface (its types, its lifecycle methods, its observers, its options object), stop and delete the model instead.

## Why this rule earns its keep

A library is the load-bearing description of a domain that has already been thought through. Yjs has thought about CRDT replicas. ArkType has thought about runtime validation. Better Auth has thought about session lifecycle. Drizzle has thought about query composition.

When the codebase grows a helper that re-shapes one of those domains into a custom abstraction, two things are usually true:

1. The custom shape covers fewer cases than the library's public surface
2. The custom shape diverges over time, while the library keeps improving

The first symptom is duplication. The second symptom is silent feature loss.

## How to apply the rule during a pass

When a finding proposes a simplification that touches a library boundary, before editing:

1. **Read the library's actual public surface** for the domain you are about to re-shape. For Epicenter the relevant references are listed below.
2. **Ground against the upstream docs.** If the user or goal requires a DeepWiki citation for this pass, use `mcp__deepwiki__ask_question` against the upstream repo. Cite the specific function or type that already does what your custom shape was doing.
3. **Compare your model to the library's model.** If yours is strictly narrower with no extra invariant, the library wins; delete your model.
4. **If yours encodes a real invariant the library does not**, name the invariant in one sentence. If you can't, the library still wins.

## Upstream repos that recur in Epicenter

Cite against the relevant one when grounding a finding:

- `arktypeio/arktype` for validators, schema merges, branded types, `'+': 'delete'` projections
- `yjs/yjs` for CRDT types, observer lifecycles, transaction boundaries, sub-document GUIDs
- `yjs/y-indexeddb` for browser persistence shape and lifecycle
- `standard-schema/standard-schema` when bridging multiple validator libraries
- `sveltejs/svelte` and `sveltejs/kit` for runes, stores, adapters
- `honojs/hono` for HTTP routing, middleware composition, error handling
- `better-auth/better-auth` for session, plugin, and adapter surfaces
- `drizzle-team/drizzle-orm` for schema, query, and migration shape
- `huntabyte/shadcn-svelte` and `ieedan/shadcn-svelte-extras` for UI primitive composition
- `useautumn/autumn` for billing primitives
- `jsrepojs/jsrepo` for installable-block packaging
- `tanstack/ai` and `TanStack/table` for the TanStack families

## What a library refusal looks like

Concrete shapes that should stop a refactor and surface to the user:

- You are about to write a custom `Observer`-like type because the existing object "doesn't quite fit." The library already ships an observer.
- You are about to extract a `*Manager` to wrap a library client's session, but the library already owns the session and provides the lifecycle hook you need.
- You are about to copy a library's type into your own package "to remove the dependency" from a leaf module. The leaf module imports the library implicitly anyway; the copy just hides it.
- You are about to add an option named for an implementation step (`refreshFn`, `decryptCallback`) because the library's policy-shaped option (`refresh`, `decrypt`) "doesn't feel right." The policy shape is intentional.

In every case, the move is to delete the local model, not extend it.
