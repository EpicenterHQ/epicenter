# Why I Pass Callbacks to `.mutate()`

TanStack Query mutations have two callback layers. Put shared lifecycle behavior on the mutation options. Put local UI behavior at the `.mutate()` call site.

That distinction matters in Svelte components because local UI state lives at the click handler, form handler, or dialog boundary.

## The Two Callback Layers

Use an options accessor when wiring a shared mutation entry:

```typescript
const deleteSession = createMutation(() => sessionMutations.deleteSession);
```

Then pass UI-specific callbacks when triggering the mutation:

```typescript
deleteSession.mutate(
	{ sessionId },
	{
		onSuccess: () => {
			isDialogOpen = false;
			toast.success('Deleted');
		},
	},
);
```

The mutation definition stays reusable. The call site keeps access to local state, props, derived values, navigation, and refs.

## Shared Callback Behavior

If every call site needs the same behavior, compose that behavior into the hook options accessor:

```typescript
const deleteSession = createMutation(() => ({
	...sessionMutations.deleteSession,
	onSuccess: (data) => {
		logAuditEvent('session_deleted', data.id);
	},
}));
```

This is still component-level TanStack setup. The shared entry stays the plain options object `resultMutations` produced.

## Local Callback Behavior

Prefer call-site callbacks for UI consequences:

```svelte
<script lang="ts">
	const copyToClipboard = createMutation(() => textMutations.copyToClipboard);

	let isDialogOpen = $state(false);
	let selectedText = $state('');
</script>

<Button
	onclick={() => {
		copyToClipboard.mutate(
			{ text: selectedText },
			{
				onSuccess: () => {
					isDialogOpen = false;
					selectedText = '';
					toast.success('Copied to clipboard');
				},
				onError: (error) => {
					report.error({ cause: error });
				},
			},
		);
	}}
>
	Copy
</Button>
```

Each interaction can do exactly what its UI context needs. A table row can show a small toast. A bulk action can update selection state. A dialog can close itself.

## Hook-Local Result Mutations

When the operation is one-off and returns a Wellcrafted `Result`, use `resultMutationOptions` directly at the hook call site:

```typescript
import { createMutation } from '@tanstack/svelte-query';
import { resultMutationOptions } from 'wellcrafted/query';

const startRecording = createMutation(() =>
	resultMutationOptions({
		mutationKey: ['recording', 'startManual'],
		mutationFn: startManualRecording,
	}),
);
```

Use a shared `resultMutations` entry only when the mutation has reusable identity or several observers. Refreshing reads after a write is the QueryClient's invalidation rule, not a reason to share one.

## Rule

- Shared mutation hook: `createMutation(() => mutations.thing)`
- Shared callback for every call: `createMutation(() => ({ ...mutations.thing, onSuccess }))`
- Local UI callback: `mutation.mutate(input, { onSuccess, onError })`
- Hook-local Result operation: `createMutation(() => resultMutationOptions({ mutationKey, mutationFn }))`
- Imperative shared mutation outside hooks: `await runMutation(queryClient, mutations.thing, input)`

Do not use `createMutation(mutations.thing)` directly. Svelte Query expects an accessor so reactive options can be tracked consistently.
