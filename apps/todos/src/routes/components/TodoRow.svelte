<!--
	One todo in the list. Its checkbox is an edit like any other: a draft
	that starts from the row the list shows and is saved at once. Any other
	view editing the same todo holds its own draft; the saves merge.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { createDraftState } from '@epicenter/folder/svelte';
	import { createMutation, useIsMutating } from '@tanstack/svelte-query';
	import type { TodoFields } from '$lib/definition.js';
	import { todosKeys } from '$lib/session.js';
	import type { TodoEntry } from '$lib/todo-listing.js';
	import { getTodos } from '$lib/todos.svelte.js';

	const todos = getTodos();

	let {
		entry,
		selected = false,
		onOpen,
	}: {
		entry: TodoEntry;
		/** Whether the detail shows this todo. */
		selected?: boolean;
		onOpen?: (stem: string) => void;
	} = $props();

	const save = createMutation(() => todos.rows.save);
	const draft = createDraftState<TodoFields>({ save: (sent) => save.mutateAsync(sent) });
	// The list keys each row by its stem, so a row's path never changes.
	// svelte-ignore state_referenced_locally
	const deleting = useIsMutating({ mutationKey: todosKeys.remove(entry.path) });
	const done = $derived((draft.row ?? entry.row).fields.done);
	const title = $derived.by(() => {
		const typed = entry.row.fields.title;
		if (typed.trim() !== '') return typed;
		// An empty stem (`todos/.md`) is a real address but not a readable label.
		return entry.stem === '' ? entry.path : entry.stem;
	});
</script>

<li
	class="flex items-center gap-2 border-b px-3 py-2 text-sm {selected
		? 'bg-accent text-accent-foreground'
		: ''}"
>
	<Checkbox
		bind:checked={
			() => done,
			(next) => {
				draft.change(entry, (row) => {
					row.fields.done = next;
				});
				void draft.save();
			}
		}
		disabled={deleting.current > 0}
		aria-label="{done ? 'Reopen' : 'Complete'} {title}"
	/>
	<Button
		variant="ghost"
		class="h-auto min-h-9 min-w-0 flex-1 justify-start whitespace-normal text-left"
		aria-current={selected ? 'true' : undefined}
		data-todo={entry.path}
		onclick={() => onOpen?.(entry.stem)}
	>
		<span class="line-clamp-2 break-anywhere {done ? 'text-muted-foreground line-through' : ''}">{title}</span>
	</Button>
</li>
