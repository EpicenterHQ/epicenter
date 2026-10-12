<!--
	One todo in the list. Its checkbox is an edit like any other: it changes
	the cached row, and this row's own write mutation saves it, one write at a
	time with any view editing the same todo.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { createMutation } from '@tanstack/svelte-query';
	import { type TodoEntry, todos } from '$lib/todos.svelte.js';

	let {
		entry,
		onOpen,
	}: {
		entry: TodoEntry;
		onOpen?: () => void;
	} = $props();

	const write = createMutation(() => todos.rowWrite(entry.stem));
	const selected = $derived(todos.selected?.as === 'todos' && todos.selected.path === entry.path);
	const done = $derived(entry.row.fields.done);
	/** While the todo is open as text, its text is what saves, so its checkbox waits. */
	const asText = $derived(todos.selected?.path === entry.path && todos.selected.as !== 'todos');
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
				if (todos.edit(entry.stem, (row) => ({ ...row, fields: { ...row.fields, done: next } })))
					write.mutate();
			}
		}
		disabled={todos.departing || asText || todos.isMoving(entry.path)}
		aria-label="{done ? 'Reopen' : 'Complete'} {title}"
	/>
	<Button
		variant="ghost"
		class="h-auto min-h-9 min-w-0 flex-1 justify-start whitespace-normal text-left"
		aria-current={selected ? 'true' : undefined}
		data-todo={entry.path}
		onclick={() => {
			todos.select(entry.path, 'todos');
			onOpen?.();
		}}
	>
		<span class="line-clamp-2 break-anywhere {done ? 'text-muted-foreground line-through' : ''}">{title}</span>
	</Button>
</li>
