<!--
	One todo in the list. Its checkbox and title show the saved row.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { toast } from '@epicenter/ui/sonner';

	import { getFolder } from '$lib/folder.js';
	import { labelOf, type Todo, todoPath } from '$lib/local-todos.js';

	const folder = getFolder();

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

	async function toggleDone() {
		const { error } = await folder.tables.todos.update(todo.id, {
			fields: { done: !todo.fields.done },
		});
		if (error !== null)
			toast.error('Could not update todo', { description: error.message });
	}
	const label = $derived(labelOf(todo));
</script>

<li
	class="flex flex-col gap-2 border-b px-3 py-2 text-sm {selected
		? 'bg-accent text-accent-foreground'
		: ''}"
>
	<div class="flex items-center gap-2">
		<Checkbox
			bind:checked={() => todo.fields.done, () => void toggleDone()}
			aria-label="{todo.fields.done ? 'Reopen' : 'Complete'} {label}"
		/>
		<Button
			variant="ghost"
			class="h-auto min-h-9 min-w-0 flex-1 justify-start whitespace-normal text-left"
			aria-current={selected ? 'true' : undefined}
			data-todo={todoPath(todo.id)}
			onclick={() => onOpen?.(todo.id)}
		>
			<span class="line-clamp-2 break-anywhere {todo.fields.done ? 'text-muted-foreground line-through' : ''}">{label}</span>
		</Button>
	</div>
</li>
