# Exhaustive union handling

## Find switches that should cover every case

If you are reviewing a directory, start by finding its switches. For example:

```sh
rg -n '\bswitch\b' packages/ai/src/agent
```

For each relevant switch, follow the value to its type. If the type
lists every possible case and the switch is responsible for all of
them, give each case an explicit branch and end with
`default: value satisfies never`. A case can explicitly do nothing.

If the value can contain arbitrary input, decide how the switch
should handle unfamiliar values.

## Agent loop events

[EngineChunk](../../../../packages/ai/src/agent/stream.ts) declares the
three events the stream adapter can produce. The
[agent loop](../../../../packages/ai/src/agent/loop.ts) appends text for
`text-delta`, records the request for `tool-call`, and records the
failure for `run-error`. The switch ends with

```ts
default:
  chunk satisfies never;
```

Add a fourth variant to `EngineChunk` and TypeScript flags this line
until the loop handles it. The stream adapter interprets provider
input before passing these events to the loop.

## Provider finish reasons

The provider’s [finish reason](../../../../packages/ai/src/client.ts) can
be any string. [incompleteFinish](../../../../packages/ai/src/agent/stream.ts)
handles known reasons and uses its `default` to report unfamiliar ones
as an incomplete stream. Keep that fallback because providers can send
reasons the code has never seen.
