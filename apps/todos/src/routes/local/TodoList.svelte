<!--
	The todo list over this browser's local folder: adding a todo, the todos
	that read as todos, and the rows that do not, each with its file and why.
	Every view reads the same mirror, so the list and the open todo never
	disagree.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { getFolder } from '$lib/folder.js';
	import {
		reasonOf,
		repairsOf,
		todoPath,
		todosOf,
		unreadableOf,
	} from '$lib/local-todos.js';
	import TodoRow from './TodoRow.svelte';

	const folder = getFolder();

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

	const rows = $derived(folder.tables.todos.rows);
	const todos = $derived(todosOf(rows));
	const repairs = $derived(repairsOf(rows));
	const unreadable = $derived(unreadableOf(rows));
	let adding = $state(false);

	async function add() {
		const typed = title.trim();
		if (typed === '' || adding) return;
		adding = true;
		try {
			const id = crypto.randomUUID();
			const { error } = await folder.tables.todos.create(id, {
				fields: { title: typed, done: false },
			});
			if (error !== null) return;
			title = '';
			onOpen?.(id);
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
			{#each todos as todo (todo.id)}
				<TodoRow {todo} selected={open === todo.id} {onOpen} />
			{:else}
				<li>
					<Empty.Root>
						<Empty.Title>No todos yet</Empty.Title>
						<Empty.Description>Add your first todo above.</Empty.Description>
					</Empty.Root>
				</li>
			{/each}
		</ul>

		{#if repairs.length > 0}
			<!-- Not todos the list can edit: each opens with its text and what does not fit. -->
			<section class="max-h-[40%] shrink-0 overflow-y-auto border-t bg-destructive/5 px-3 py-2 text-xs" aria-label="Needs repair">
				<p class="flex items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					{repairs.length === 1 ? 'This file does' : 'These files do'} not read as a todo. Todos keeps {repairs.length === 1 ? 'its' : 'their'} text as it is.
				</p>
				<ul class="mt-1 space-y-1.5">
					{#each repairs as repair (repair.id)}
						<li class="flex items-start gap-2">
							<div class="min-w-0 flex-1">
								<code class="font-mono break-anywhere">{todoPath(repair.id)}</code>
								<p class="text-muted-foreground">{reasonOf(repair)}</p>
							</div>
							<Button
								size="xs"
								variant="outline"
								aria-current={open === repair.id ? 'true' : undefined}
								onclick={() => onOpen?.(repair.id)}
							>
								Show
							</Button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if unreadable.length > 0}
			<!-- Files whose source cannot be shown here. -->
			<section class="max-h-[40%] shrink-0 overflow-y-auto border-t bg-destructive/5 px-3 py-2 text-xs" aria-label="Could not read">
				<p class="flex items-center gap-2 font-medium">
					<Badge variant="destructive">Could not read</Badge>
					{unreadable.length === 1 ? 'This file cannot' : 'These files cannot'} be shown as text.
				</p>
				<ul class="mt-1 space-y-1.5">
					{#each unreadable as file (file.id)}
						<li class="flex items-start gap-2">
							<div class="min-w-0 flex-1">
								<code class="font-mono break-anywhere">{todoPath(file.id)}</code>
								<p class="text-muted-foreground">{reasonOf(file)}</p>
							</div>
							<Button size="xs" variant="outline" onclick={() => onOpen?.(file.id)}>Show</Button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
</section>
