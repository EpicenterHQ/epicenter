<!--
	One todo in the list. Its checkbox and title show the todo as listed; a
	todo still on this device, signed in, is marked until it uploads.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { toast } from '@epicenter/ui/sonner';
	import { auth } from '$lib/auth.js';
	import { getTodos } from '$lib/context.js';
	import { isDesktop } from '$lib/device.js';
	import { labelOf, type TodoRow } from '$lib/todos.js';

	const todos = getTodos();

	let {
		todo,
		selected = false,
		onOpen,
	}: {
		todo: TodoRow;
		/** Whether the detail shows this todo. */
		selected?: boolean;
		onOpen?: (id: string) => void;
	} = $props();

	async function toggleDone() {
		const { error } = await todos.update({ id: todo.id }, { done: !todo.done });
		if (error !== null)
			toast.error('Could not update todo', { description: error.message });
	}
	const label = $derived(labelOf(todo));
</script>

<li
	class="flex flex-col gap-2 border-b px-3 py-2 text-sm {selected
		? 'bg-accent text-accent-foreground'
		: ''}"
	data-id={todo.id}
	data-where={todo.where}
>
	<div class="flex items-center gap-2">
		<Checkbox
			bind:checked={() => todo.done, () => void toggleDone()}
			aria-label="{todo.done ? 'Reopen' : 'Complete'} {label}"
		/>
		<Button
			variant="ghost"
			class="h-auto min-h-9 min-w-0 flex-1 justify-start whitespace-normal text-left"
			aria-current={selected ? 'true' : undefined}
			data-todo={todo.id}
			onclick={() => onOpen?.(todo.id)}
		>
			<span class="line-clamp-2 break-anywhere {todo.done ? 'text-muted-foreground line-through' : ''}">{label}</span>
		</Button>
		{#if todo.where === 'device' && !isDesktop && auth.state.status !== 'signed-out'}
			<Badge variant="outline" class="shrink-0">not uploaded yet</Badge>
		{/if}
	</div>
</li>
