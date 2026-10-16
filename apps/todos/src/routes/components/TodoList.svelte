<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { describeError } from '$lib/describe-error.js';
	import { todoStem } from '$lib/todo-listing.js';
	import { getTodos } from '$lib/todos.svelte.js';
	import TodoRow from './TodoRow.svelte';

	const todos = getTodos();

	let {
		open,
		onOpen,
	}: {
		/** The stem of the todo the detail shows, if any. */
		open?: string;
		/** Show the todo `stem` in the detail. */
		onOpen?: (stem: string) => void;
	} = $props();

	const listing = createQuery(() => todos.rows.todos);
	const repairQuery = createQuery(() => todos.rows.repairs);
	const unreadableQuery = createQuery(() => todos.rows.unreadable);
	const repairs = $derived(repairQuery.data ?? []);
	const unreadable = $derived(unreadableQuery.data ?? []);
	/** The title typed for a new todo. It goes with the list: leaving with it half-typed drops it. */
	let title = $state('');
	// The failure is reported by the mutation, not this call, so it shows even
	// when the list unmounted while the todo was being added.
	const create = createMutation(() => ({
		...todos.rows.create.options,
		onError: (error, typed) =>
			toast.error('Could not add the todo', { description: `"${typed}": ${describeError(error)}` }),
	}));

	function add(event: SubmitEvent) {
		event.preventDefault();
		const typed = title.trim();
		if (typed === '' || create.isPending) return;
		create.mutate(typed, {
			onSuccess: (created) => {
				title = '';
				const stem = created === null ? undefined : todoStem(created.path);
				if (stem !== undefined) onOpen?.(stem);
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
			disabled={create.isPending}
		/>
		<Button type="submit" disabled={create.isPending || title.trim() === ''}>
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
			{#each listing.data as entry (entry.stem)}
				<TodoRow {entry} selected={open === entry.stem} {onOpen} />
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
			<!-- Not todos the list can edit: each opens with its text and what to fix, in another editor. -->
			<section class="max-h-[40%] shrink-0 overflow-y-auto border-t bg-destructive/5 px-3 py-2 text-xs" aria-label="Needs repair">
				<p class="flex items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					{repairs.length === 1 ? 'This file does' : 'These files do'} not read as a todo. Fix {repairs.length === 1 ? 'it' : 'them'} in a text editor, and Todos shows the result.
				</p>
				<ul class="mt-1 space-y-1.5">
					{#each repairs as repair (repair.stem)}
						<li class="flex items-start gap-2">
							<div class="min-w-0 flex-1">
								<code class="font-mono break-anywhere">{repair.path}</code>
								<p class="text-muted-foreground">{repair.reason}</p>
							</div>
							<Button
								size="xs"
								variant="outline"
								aria-current={open === repair.stem ? 'true' : undefined}
								onclick={() => onOpen?.(repair.stem)}
							>
								Show
							</Button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if unreadable.length > 0}
			<!-- Files Todos could not read as text: nothing to repair here; reading again may work. -->
			<section class="max-h-[40%] shrink-0 overflow-y-auto border-t bg-destructive/5 px-3 py-2 text-xs" aria-label="Could not read">
				<p class="flex items-center gap-2 font-medium">
					<Badge variant="destructive">Could not read</Badge>
					{unreadable.length === 1 ? 'This file' : 'These files'} could not be read. Fix {unreadable.length === 1 ? 'it' : 'them'} with another program, then try again.
				</p>
				<ul class="mt-1 space-y-1.5">
					{#each unreadable as file (file.stem)}
						<li class="min-w-0">
							<code class="font-mono break-anywhere">{file.path}</code>
							<p class="text-muted-foreground">{file.reason}</p>
						</li>
					{/each}
				</ul>
				<Button class="mt-1.5" size="xs" variant="outline" onclick={() => void todos.refresh()}>Try again</Button>
			</section>
		{/if}
	{/if}
</section>
