<!--
	One todo in the list. Its checkbox shows the file and sends its change at
	once, a field set on the file as it is now (ADR-0576), so it never undoes a
	title typed in the detail; the todo's writes run one at a time.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
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

	const done = $derived(entry.row.fields.done);
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
			(next) => todos.edits.set('todos', entry.stem, { done: next })
		}
		disabled={todos.edits.locked(entry.path)}
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
