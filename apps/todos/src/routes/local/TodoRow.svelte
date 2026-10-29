<!--
	One todo in the list. Its checkbox and title show the note as this
	device has it; a toggle shows at once.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { getRepository } from '$lib/repository.js';
	import { labelOf, reportWrite, type Todo, todoPath } from '$lib/local-todos.js';

	const repo = getRepository();

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

	const label = $derived(labelOf(todo));
</script>

<li
	class="flex flex-col gap-2 border-b px-3 py-2 text-sm {selected
		? 'bg-accent text-accent-foreground'
		: ''}"
>
	<div class="flex items-center gap-2">
		<Checkbox
			bind:checked={() => todo.fields.done, (done) => void reportWrite(repo.todos.patch(todo.params, { done }), 'Could not update todo')}
			aria-label="{todo.fields.done ? 'Reopen' : 'Complete'} {label}"
		/>
		<Button
			variant="ghost"
			class="h-auto min-h-9 min-w-0 flex-1 justify-start whitespace-normal text-left"
			aria-current={selected ? 'true' : undefined}
			data-todo={todoPath(todo.params.stem)}
			onclick={() => onOpen?.(todo.params.stem)}
		>
			<span class="line-clamp-2 break-anywhere {todo.fields.done ? 'text-muted-foreground line-through' : ''}">{label}</span>
		</Button>
	</div>
</li>
