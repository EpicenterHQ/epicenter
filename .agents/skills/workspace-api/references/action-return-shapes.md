# Action Return Shapes: Direct Calls Vs Adapters

Actions have two useful views:

```txt
direct call     workspace.actions.tabs_close({ ... })
adapter call    invokeAction(workspace.actions.tabs_close, unknownInput)
```

A direct caller sees exactly what the handler author wrote. An adapter caller
gets `Promise<Result<T, unknown>>` from `invokeAction`.

## Call Contexts

```txt
1. DIRECT
   workspace.actions.tabs_close({ tabIds })
   Same process, direct function call. No wrapping.

2. ADAPTER
   invokeAction(action, input)
   app CLI, AI, or MCP tool bridge
   Input validates against the action schema before the handler runs.

3. COLLABORATION
   openCollaboration(...)
   Sync and presence only. No in-room action dispatch.
```

## One Handler, Every Caller's View

| Caller | Raw ok value | Handler returns `Err(BrowserApiFailed)` | Handler throws |
| --- | --- | --- | --- |
| Direct local call | raw value | `{ data: null, error: BrowserApiFailed }` | throws |
| `invokeAction` | `Ok(raw)` | same `Err(BrowserApiFailed)` | `Err(cause)` |
| App CLI adapter | prints success payload | usage/runtime error response | runtime error response |
| AI bridge | tool success payload | tool failure | tool failure |

`invokeAction` is the adapter boundary. It:

1. Validates `input` when the action declared an `input` schema.
2. Calls the handler directly.
3. Wraps non-`Result` returns in `Ok(...)`.
4. Preserves returned `Result`s.
5. Catches thrown errors and returns `Err(cause)`.

## Handler Rule

Return `Err` for failures local callers should branch on. Throw for bugs and
invariants. Return raw when failure is not a meaningful concept for the
operation.

Do not return a bare tagged error object. `invokeAction` treats non-`Result`
returns as success, and the action type guard rejects bare wellcrafted tagged
errors for this reason.

## Example

```typescript
const local = await workspace.actions.tabs_close({ tabIds: [1] });
if (local.error) {
	toast.error(local.error.message);
	return;
}

const adapter = await invokeAction<{ closedCount: number }>(
	workspace.actions.tabs_close,
	{ tabIds: [1] },
);
if (adapter.error) {
	toast.error(extractErrorMessage(adapter.error));
	return;
}

console.log(adapter.data.closedCount);
```

If another surface needs this action, expose it through an application-specific
tool or service adapter. Do not resurrect in-room peer dispatch: current
collaboration publishes presence and syncs Yjs updates only.

## Invariants

1. Direct callers never get adapter wrapping unless they call `invokeAction`.
2. Handlers can be sync, async, return raw, return `Result`, or throw.
3. `invokeAction` normalizes once at the adapter boundary.
4. Input validation belongs at the adapter boundary when `input` is declared.
5. `openCollaboration` does not expose `dispatch`; ADR-0073 removed in-room
   dispatch.
