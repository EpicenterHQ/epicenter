<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { describeError } from '$lib/describe-error.js';
	import { getTodos, repairsOf, todosOf } from '$lib/todos.svelte.js';
	import TodoRow from './TodoRow.svelte';

	const todos = getTodos();

	let { onOpen }: { onOpen?: () => void } = $props();

	const listing = createQuery(() =>
		todos.rowsQuery((rows) => ({ entries: todosOf(rows), repairs: repairsOf(rows) })),
	);
	/** The title typed for a new todo. It goes with the list: leaving with it half-typed drops it. */
	let title = $state('');
	// The failure is reported by the mutation, not this call, so it shows even
	// when the list unmounted while the todo was being added.
	const create = createMutation(() => ({
		...todos.create.options,
		onError: (error, typed) =>
			toast.error('Could not add the todo', { description: `"${typed}": ${describeError(error)}` }),
	}));

	function add(event: SubmitEvent) {
		event.preventDefault();
		const typed = title.trim();
		if (typed === '' || create.isPending) return;
		create.mutate(typed, {
			onSuccess: () => {
				title = '';
				onOpen?.();
			},
		});
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo list">
	<form class="flex shrink-0 items-center gap-2 border-b p-3" onsubmit={add}>
		<Input
			bind:value={title}
			placeholder="Add a todo"
			aria-label="New todo title"
			disabled={create.isPending || todos.departing}
		/>
		<Button type="submit" disabled={create.isPending || todos.departing || title.trim() === ''}>
			{create.isPending ? 'Adding…' : 'Add'}
		</Button>
	</form>

	{#if listing.isError}
		<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
			Could not read the todos folder: {listing.error.message}.
			{listing.data === undefined ? '' : 'Showing the last list that was read.'}
		</p>
	{/if}

	{#if listing.data === undefined}
		{#if listing.isPending}
			<Loading class="flex-1" label="Reading your todos…" />
		{:else}
			<div class="flex-1"></div>
		{/if}
	{:else}
		<ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Todos">
			{#each listing.data.entries as entry (entry.stem)}
				<TodoRow {entry} {onOpen} />
			{:else}
				<li>
					<Empty.Root>
						<Empty.Title>No todos yet</Empty.Title>
						<Empty.Description>Add your first todo above.</Empty.Description>
					</Empty.Root>
				</li>
			{/each}
		</ul>

		{#if listing.data.repairs.length > 0}
			<!-- Not todos the list can edit: each opens as its text, for repair. -->
			<section class="max-h-[40%] shrink-0 overflow-y-auto border-t bg-destructive/5 px-3 py-2 text-xs" aria-label="Needs repair">
				<p class="flex items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					{listing.data.repairs.length === 1 ? 'This file does' : 'These files do'} not read as a todo. Repair opens its text.
				</p>
				<ul class="mt-1 space-y-1.5">
					{#each listing.data.repairs as repair (repair.path)}
						<li class="flex items-start gap-2">
							<div class="min-w-0 flex-1">
								<code class="font-mono break-anywhere">{repair.path}</code>
								<p class="text-muted-foreground">{repair.reason}</p>
							</div>
							<Button
								size="xs"
								variant="outline"
								onclick={() => {
									todos.select(repair.path, 'repair');
									onOpen?.();
								}}
							>
								Repair
							</Button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</section>
