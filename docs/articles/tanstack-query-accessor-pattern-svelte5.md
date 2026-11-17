# The TanStack Query Accessor Pattern In Svelte 5

> **Historical snapshot.** This recording-player bug illustrates why a query must follow a changing recording ID. The two-accessor recipe and RPC examples below use the shared query API from that period. For current Svelte query factories and hook calls, see [the query-layer skill](../../.agents/skills/query-layer/SKILL.md#compose-a-service-in-two-maps).

I was building a recording player in Svelte 5 with TanStack Query to fetch audio URLs. The first recording loaded, but selecting a different recording left the query stuck on the old URL.

The bug was not in TanStack Query or the RPC layer. I had skipped the accessor that lets Svelte track the reactive input.

## The Broken Shape

```typescript
const recordingId = $state('abc-123');

const playbackUrl = createQuery(() =>
	rpc.audio.getPlaybackUrl(recordingId).options,
);
```

`recordingId` is reactive inside the component, but passing it directly sends the current string value into `getPlaybackUrl`. The RPC definition has no way to read the next value.

## The Correct Shape

```typescript
const recordingId = $state('abc-123');

const playbackUrl = createQuery(() =>
	rpc.audio.getPlaybackUrl(() => recordingId).options,
);
```

There are two accessors here:

```typescript
createQuery(() =>
	rpc.audio.getPlaybackUrl(() => recordingId).options,
);
```

- The outer `() => ...` is the Svelte Query options accessor.
- The inner `() => recordingId` is the domain parameter accessor.

The outer accessor lets Svelte Query re-read the options. The inner accessor lets the shared query definition read the current recording ID when it builds the key and query function.

## When To Use A Parameter Accessor

Use an accessor when the value can change during the component lifetime:

```typescript
const fromProps = createQuery(() =>
	rpc.audio.getPlaybackUrl(() => props.recordingId).options,
);

const fromState = createQuery(() =>
	rpc.audio.getPlaybackUrl(() => recordingId).options,
);

const fromDerived = createQuery(() =>
	rpc.audio.getPlaybackUrl(() => computedId).options,
);
```

Pass a plain value only when it is static for that query instance:

```typescript
const staticRecording = createQuery(() =>
	rpc.audio.getPlaybackUrl('static-id').options,
);

const RECORDING_ID = 'abc-123';
const constantRecording = createQuery(() =>
	rpc.audio.getPlaybackUrl(RECORDING_ID).options,
);
```

## Common Mistakes

Put the parameter accessor in the RPC method call, then read `.options` as a property:

```typescript
// Wrong
createQuery(() => rpc.audio.getPlaybackUrl.options(() => recordingId));

// Right
createQuery(() => rpc.audio.getPlaybackUrl(() => recordingId).options);
```

Do not pass `.options` directly to `createQuery`:

```typescript
// Wrong
createQuery(rpc.audio.getPlaybackUrl(() => recordingId).options);

// Right
createQuery(() => rpc.audio.getPlaybackUrl(() => recordingId).options);
```

Do not call `.options` like a function:

```typescript
// Wrong
createQuery(() => rpc.audio.getPlaybackUrl(() => recordingId).options());

// Right
createQuery(() => rpc.audio.getPlaybackUrl(() => recordingId).options);
```

## Hook-Local Queries

If the query is only used at one hook call site, skip the shared RPC definition and use Wellcrafted `queryOptions` locally:

```typescript
import { createQuery } from '@tanstack/svelte-query';
import { queryOptions } from 'wellcrafted/query';

const devices = createQuery(() =>
	queryOptions({
		queryKey: ['devices'],
		queryFn: () => enumerateDevices(),
	}),
);
```

Use a shared `defineQuery` when the query belongs in `$lib/rpc` or `$lib/query`, has reusable identity, or needs imperative `.fetch()` or `.ensure()` calls.

## Rule

If the parameter can change, pass `() => value` to the shared query definition. In Svelte components, wrap the whole options expression in `createQuery(() => ...)`.

Queries are not callable. Use `.fetch()` when a user action needs a fresh read, and `.ensure()` when cache-first data is acceptable.
