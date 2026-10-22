<!--
	The todo list over this browser's local folder: adding a todo, the todos
	that read as todos, and the rows that do not, each with its file and why.
	Every view reads the one rows query, so the list and the open todo never
	disagree.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { getFolder } from '$lib/folder.js';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import {
		describeFailure,
		reasonOf,
		repairsOf,
		todoPath,
		todosOf,
		unreadableOf,
	} from '$lib/local-todos.js';
	import TodoRow from './TodoRow.svelte';

	const { folder, queries, refresh, getStatus } = getFolder();

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

	const rows = createQuery(() => queries.rows('todos'));
	const todos = $derived(rows.data === undefined ? undefined : todosOf(rows.data));
	const repairs = $derived(repairsOf(rows.data ?? []));
	const unreadable = $derived(unreadableOf(rows.data ?? []));
	// The failure is reported by the mutation, not this call, so it shows even
	// when the list unmounted while the todo was being added.
	const create = createMutation(() => ({
		mutationFn: async (typed: string) => {
			const id = crypto.randomUUID();
			const { error } = await folder.tables.todos.write(id, {
				fields: { title: typed, done: false },
				body: '',
			});
			if (error !== null) throw error;
			// Listed before it opens, so the detail never says it is gone.
			await refresh([`todos/${id}.md`]);
			return id;
		},
		onError: (error: Parameters<typeof describeFailure>[0], typed: string) =>
			toast.error('Could not add the todo', { description: `"${typed}": ${describeFailure(error)}` }),
	}));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo list">
	<form
		class="flex shrink-0 items-center gap-2 border-b p-3"
		onsubmit={(event) => {
			event.preventDefault();
			const typed = title.trim();
			if (typed === '' || create.isPending) return;
			create.mutate(typed, {
				onSuccess: (id) => {
					title = '';
					onOpen?.(id);
				},
			});
		}}
	>
		<Input
			bind:value={title}
			placeholder="Add a todo"
			aria-label="New todo title"
			disabled={create.isPending || getStatus().closing}
		/>
		<Button type="submit" disabled={create.isPending || getStatus().closing || title.trim() === ''}>
			{create.isPending ? 'Adding…' : 'Add'}
		</Button>
	</form>

	{#if rows.isError}
		<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
			Could not read your todos: {rows.error.message}.
			{rows.data === undefined ? '' : 'Showing the last list that was read.'}
		</p>
	{/if}

	{#if todos === undefined}
		{#if rows.isPending}
			<Loading class="flex-1" label="Reading your todos…" />
		{:else}
			<div class="flex-1"></div>
		{/if}
	{:else}
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
			<!-- Files that are not text: kept as they are, with nothing here to edit. -->
			<section class="max-h-[40%] shrink-0 overflow-y-auto border-t bg-destructive/5 px-3 py-2 text-xs" aria-label="Could not read">
				<p class="flex items-center gap-2 font-medium">
					<Badge variant="destructive">Could not read</Badge>
					{unreadable.length === 1 ? 'This file is' : 'These files are'} not text, so Todos cannot show {unreadable.length === 1 ? 'it' : 'them'}.
				</p>
				<ul class="mt-1 space-y-1.5">
					{#each unreadable as file (file.id)}
						<li class="min-w-0">
							<code class="font-mono break-anywhere">{todoPath(file.id)}</code>
							<p class="text-muted-foreground">{reasonOf(file)}</p>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</section>
