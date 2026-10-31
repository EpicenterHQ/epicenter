<!--
	The todo list: adding a todo, the todos that read as todos, and the notes
	at a todo's path that do not, each with its file and why. Every view
	reads the same list, so the list and the open todo never disagree.
-->
<script lang="ts">
	import { timeId } from '@epicenter/definition/ids';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { getTodos } from '$lib/context.js';
	import { describeIssues } from '@epicenter/definition/contract';
	import TodoRow from './TodoRow.svelte';

	const todos = getTodos();

	let {
		open,
		onOpen,
		title = $bindable(''),
	}: {
		/** The id of the todo the detail shows, if any. */
		open?: string;
		/** Show the todo `id` in the detail. */
		onOpen?: (id: string) => void;
		/** A new todo's input stays on the page until Add commits it. */
		title?: string;
	} = $props();

	let adding = $state(false);

	async function add() {
		const typed = title.trim();
		if (typed === '' || adding) return;
		adding = true;
		try {
			const { data, error } = await todos.create({
				id: timeId(),
				title: typed,
				done: false,
			});
			if (error !== null) {
				toast.error('Could not add todo', { description: error.message });
				return;
			}
			title = '';
			onOpen?.(data.id);
		} finally {
			adding = false;
		}
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo list">
	<form
		class="flex shrink-0 items-center gap-2 border-b p-3"
		onsubmit={(event) => {
			event.preventDefault();
			void add();
		}}
	>
		<Input
			bind:value={title}
			placeholder="Add a todo"
			aria-label="New todo title"
			disabled={adding}
		/>
		<Button type="submit" disabled={adding || title.trim() === ''}>
			{adding ? 'Adding…' : 'Add'}
		</Button>
	</form>

	<div class="flex min-h-0 flex-1 flex-col">
		<ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Todos">
			{#each todos.items as todo (todo.id)}
				<TodoRow {todo} selected={open === todo.id} {onOpen} />
			{:else}
				{#if !todos.loading}
					<li>
						<Empty.Root>
							<Empty.Title>No todos yet</Empty.Title>
							<Empty.Description>Add your first todo above.</Empty.Description>
						</Empty.Root>
					</li>
				{/if}
			{/each}
		</ul>

		{#if todos.invalid.length > 0}
			<!-- Not todos the list can edit: each opens with its text, to repair or delete. -->
			<section class="max-h-[40%] shrink-0 overflow-y-auto border-t bg-destructive/5 px-3 py-2 text-xs" aria-label="Needs repair">
				<p class="flex items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					{todos.invalid.length === 1 ? 'This file does' : 'These files do'} not read as a todo. Todos keeps {todos.invalid.length === 1 ? 'its' : 'their'} text as it is.
				</p>
				<ul class="mt-1 space-y-1.5">
					{#each todos.invalid as note (note.id)}
						<li class="flex items-start gap-2" data-invalid={note.id}>
							<div class="min-w-0 flex-1">
								<code class="font-mono break-anywhere">{note.path}</code>
								<p class="text-muted-foreground">
									{note.text === null
										? 'It is not text.'
										: describeIssues(note.issues)}
								</p>
							</div>
							<Button
								size="xs"
								variant="outline"
								aria-current={open === note.id ? 'true' : undefined}
								onclick={() => onOpen?.(note.id)}
							>
								Show
							</Button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
</section>
