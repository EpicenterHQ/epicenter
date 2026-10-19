<!--
	One todo in the list. Its checkbox shows the todo with what is typed over
	it and saves at once, together with any title or notes still waiting for
	their pause. The title is the saved one: what is typed shows in the list
	once it is saved.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { getFolder } from '@epicenter/svelte/folder';
	import type { todosTables } from '$lib/definition.js';
	import { labelOf, type Todo, todoPath } from '$lib/local-todos.js';

	const { edits } = getFolder<typeof todosTables>();

	let {
		todo,
		selected = false,
		onOpen,
	}: {
		todo: Todo;
		/** Whether the detail shows this todo. */
		selected?: boolean;
		onOpen?: (id: string) => void;
	} = $props();

	const draft = $derived(edits.row('todos', todo.id));
	const done = $derived(draft.shown(todo).fields.done);
	const label = $derived(labelOf(todo));
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
				if (draft.change(todo, { fields: { done: next } })) void draft.save();
			}
		}
		disabled={draft.locked}
		aria-label="{done ? 'Reopen' : 'Complete'} {label}"
	/>
	<Button
		variant="ghost"
		class="h-auto min-h-9 min-w-0 flex-1 justify-start whitespace-normal text-left"
		aria-current={selected ? 'true' : undefined}
		data-todo={todoPath(todo.id)}
		onclick={() => onOpen?.(todo.id)}
	>
		<span class="line-clamp-2 break-anywhere {done ? 'text-muted-foreground line-through' : ''}">{label}</span>
	</Button>
</li>
