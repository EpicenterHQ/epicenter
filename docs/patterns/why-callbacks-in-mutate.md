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

Clearing the field here assumes the dialog still owns the submitted selection.
For what happened when people could start another selection during a save, see
[A save can finish after the person has moved on](../articles/a-save-can-finish-after-the-person-has-moved-on.md).

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

For the choice between local and shared entries, see
[the query-layer skill](../../.agents/skills/query-layer/SKILL.md#compose-a-service-in-two-maps).

## Rule

- Shared mutation hook: `createMutation(() => mutations.thing)`
- Shared callback for every call: `createMutation(() => ({ ...mutations.thing, onSuccess }))`
- Local UI callback: `mutation.mutate(input, { onSuccess, onError })`
- Hook-local Result operation: `createMutation(() => resultMutationOptions({ mutationKey, mutationFn }))`
- Imperative shared mutation outside hooks: `await runMutation(queryClient, mutations.thing, input)`

Do not use `createMutation(mutations.thing)` directly. Svelte Query expects an accessor so reactive options can be tracked consistently.
