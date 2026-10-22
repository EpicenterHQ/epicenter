<!--
	One todo in the list. Its checkbox shows the folder's edit of the todo,
	what is typed over it included, and saves at once, together with any
	title or notes still waiting for their pause. The title is the one the
	list read: what is typed shows in the list once it is saved.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { getFolder } from '$lib/folder.js';
	import { labelOf, type Todo, todoPath } from '$lib/local-todos.js';

	const { folder } = getFolder();

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

	const id = $derived(todo.id);
	// The list's read answered this row's document, so showing it reads nothing.
	const fileEdit = $derived(createFileEdit(folder.tables.todos.edit(id)));
	const done = $derived(fileEdit.content?.issues === null ? fileEdit.content.fields.done : todo.fields.done);
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
				if (fileEdit.change({ fields: { done: next } }).error === null) void fileEdit.save();
			}
		}

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
