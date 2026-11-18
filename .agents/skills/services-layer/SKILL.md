---
name: services-layer
description: Group related functions into framework-independent services with explicit inputs and Result-returning operations. Use when defining service boundaries, choosing between plain objects and factories, or adapting service operations through Wellcrafted for queries and mutations.
metadata:
  author: epicenter
  version: '5.0'
---

# Services layer

A service groups related functions for doing a particular job, usually as
methods on an object. Its functions take explicit inputs. Operations that can
fail return Results, so callers can decide what to do with success or failure.

A file service might expose reading, writing, and removing files over the same
storage capability. A module, a plain object, or a factory result can provide
that service. Choose the grouping from the work callers need.

## Choose what belongs together

Look at the operations, their callers, and the resources they use. Group
operations when they share a responsibility, dependencies, or lifecycle.

Question the number of services as well as their individual implementations.
Sharing implementation can require an internal function without requiring
another service object. Start with the operations callers need and let their
use reveal useful groupings.

## Keep services independent of the UI framework

Services are independent of the UI framework. They can make requests, write
files, and keep state, but they don’t depend on Svelte or React, read component
state, or decide what the interface displays.

Keep toasts, reporting, and TanStack Query observers outside the service.

Make dependencies and app selections explicit. Capture stable resources at
construction when several operations share them. Pass inputs that vary per
operation to the operation itself.

For example, a service that writes files receives the storage capability its
caller selected. It should write into that store rather than independently
opening a different one.

A user-selected provider is runtime policy. Keep that choice distinct from
selecting an implementation for the browser or desktop. Resolve the choice
in the operation that owns it and pass the resulting inputs to lower-level
services.

## Return outcomes callers can compose

Use `Result<T, E>` for expected failures the caller needs to handle. Operations
may return a Result synchronously or through a promise. Keep infallible work
as ordinary values or `void`; do not add a Result merely for signature
uniformity.

Errors belong to the layer that understands the failure. Preserve lower-layer
tagged errors when composing services. Define a service-local variant only
for a failure the service itself owns.

Return domain data and errors. Let the caller choose presentation and recovery.

Use [error handling](../error-handling/SKILL.md) for defining tagged errors,
adapting throwing operations, and propagating or handling Results.

## Compose selected operations through Wellcrafted

The query layer wraps selected service functions with caching and observable
pending, success, and error state. The same service functions remain available
for direct calls and for composing larger operations.

`wellcrafted/query` creates framework-independent TanStack query and mutation
options from those functions. A framework adapter, such as
`@tanstack/svelte-query`, connects the options to the UI framework.

Select reads and writes explicitly:

```typescript
import { resultMutations, resultQueries } from 'wellcrafted/query';

const userQueries = resultQueries(['users'], {
	get: userService.get,
	list: userService.list,
});

const userMutations = resultMutations(['users'], {
	update: userService.update,
	remove: userService.remove,
});
```

The first argument supplies the cache namespace. The second supplies the
Result-returning functions to adapt. The helpers preserve their input,
successful output, and error types.

Query entries take the method's arguments and return native TanStack options.
Mutation entries are already options objects; their input arrives at execution.

```typescript
userQueries.get('u1').queryKey;
// ['users', 'get', ['u1']]

userMutations.update.mutationKey;
// ['users', 'update']
```

Building these options does not execute the service. During execution,
Wellcrafted returns the data from `Ok` and throws the original error from
`Err` into TanStack's error channel.

Pass methods that work after extraction. Factory methods composed through
their closure can be passed directly. Bind receiver-dependent methods or
wrap their invocation.

The maps select operations; they do not classify arbitrary methods as reads
or writes. They also do not determine freshness, invalidation, or optimistic
updates. Those choices belong to the application.

## Choose direct calls or client execution

Call a service directly when the caller needs its outcome without query-cache
or mutation-lifecycle behavior:

```typescript
const result = await userService.get('u1');
```

Run the adapted options through a QueryClient when the operation should
participate in that client's cache or mutation lifecycle. Wellcrafted's
runners return Results again:

```typescript
import { runMutation, runQuery } from 'wellcrafted/query';

const loaded = await runQuery(queryClient, userQueries.get('u1'));

const saved = await runMutation(queryClient, userMutations.update, {
	id: 'u1',
	name: 'Ada',
});
```

A UI hook can consume the same native options. A service does not need to
know which caller will use it.

See [query layer](../query-layer/SKILL.md) for hooks, key conventions,
invalidation, client defaults, optimistic updates, and mutation lifecycle.

## Use construction when the service needs it

Use a factory when callers supply shared dependencies or configuration, each
instance needs independent state, or construction acquires resources whose
lifetime the instance owns.

Use ordinary functions or a plain object when no instance construction is
needed. Do not introduce a factory solely to satisfy a naming convention.

Follow [TypeScript guidance](../typescript/SKILL.md) for factory signatures,
internal functions, returned methods, and public types. See
[service implementation patterns](references/service-implementation-pattern.md)
for the plain-object and lifecycle examples.

## Example: recording into an app's audio store

Whispering composes a recording service from the audio store its pages use
and a recorder implementation:

```typescript
const recorder = createMicrophoneDevice({
	files: folder.audio,
	recorder: microphone,
});
```

The caller supplies the resources. The service starts recordings and returns
sessions whose `stop` operation finishes that specific recording. Its expected
failures return Results. The UI decides how to display recording state and
respond to a failure.

See [Whispering's platform services](references/service-organization-platforms.md)
when changing its browser or desktop implementations, and
[platform seams](../platform-seams/SKILL.md) for implementation selection.
