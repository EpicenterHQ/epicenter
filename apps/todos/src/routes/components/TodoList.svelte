<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import type { TodoEntry, Todos } from '$lib/todos.svelte.js';
	import { openItem } from './file-actions.js';

	let { todos, onOpen }: { todos: Todos; onOpen?: () => void } = $props();
	let adding = $state(false);
	/**
	 * Whether this list is mounted. The new todo's typed title belongs to the
	 * owner, which outlives the list on narrow screens; a form that left the
	 * document must not submit it.
	 */
	const view = { mounted: true };
	onDestroy(() => {
		view.mounted = false;
	});

	function titleOf(entry: TodoEntry) {
		const title = todos.fieldsOf(entry).title;
		if (title.trim() !== '') return title;
		// An empty stem (`todos/.md`) is a real address but not a readable label.
		return entry.stem === '' ? entry.path : entry.stem;
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (!view.mounted) return;
		const title = todos.newTitle.trim();
		if (title === '' || adding) return;
		adding = true;
		// On success the owner clears the typed title itself.
		const problem = await todos.create(title);
		adding = false;
		if (problem) toast.error('Could not add the todo', { description: problem });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo list">
	<form class="flex shrink-0 items-center gap-2 border-b p-3" onsubmit={add}>
		<Input
			bind:value={() => todos.newTitle, (title) => todos.newTitle = title}
			placeholder="Add a todo"
			aria-label="New todo title"
			disabled={adding}
		/>
		<Button type="submit" disabled={adding || todos.newTitle.trim() === ''}>
			{adding ? 'Adding…' : 'Add'}
		</Button>
	</form>

	{#if todos.listError}
		<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
			Could not read the todos folder: {todos.listError}. Showing the last list that was read.
		</p>
	{/if}

	<ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Todos">
		{#each todos.entries as entry (entry.path)}
			{@const selected = todos.current?.workspace === 'todos' && todos.current.path === entry.path}
			{@const done = todos.fieldsOf(entry).done}
			<li
				class="flex items-center gap-2 border-b px-3 py-2 text-sm {selected
					? 'bg-accent text-accent-foreground'
					: ''}"
			>
				<Checkbox
					bind:checked={
						() => done,
						() => {
							void todos.toggle(entry).then((problem) => {
								if (problem) toast.error('Could not change the todo', { description: problem });
							});
						}
					}
					aria-label="{done ? 'Reopen' : 'Complete'} {titleOf(entry)}"
				/>
				<Button
					variant="ghost"
					class="h-auto min-h-9 min-w-0 flex-1 justify-start whitespace-normal text-left"
					aria-current={selected ? 'true' : undefined}
					data-todo={entry.path}
					onclick={() => {
						void openItem(todos, entry.path, 'todos');
						onOpen?.();
					}}
				>
					<span class="line-clamp-2 break-anywhere {done ? 'text-muted-foreground line-through' : ''}">{titleOf(entry)}</span>
				</Button>
			</li>
		{:else}
			<li>
				<Empty.Root>
					<Empty.Title>No todos yet</Empty.Title>
					<Empty.Description>Add your first todo above.</Empty.Description>
				</Empty.Root>
			</li>
		{/each}
	</ul>

	{#if todos.repairs.length > 0}
		<!-- Not todos the list can edit: each opens in Files, as its text, for repair. -->
		<section class="max-h-[40%] shrink-0 overflow-y-auto border-t bg-destructive/5 px-3 py-2 text-xs" aria-label="Needs repair">
			<p class="flex items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				{todos.repairs.length === 1 ? 'This file does' : 'These files do'} not read as a todo. Repair opens its text.
			</p>
			<ul class="mt-1 space-y-1.5">
				{#each todos.repairs as repair (repair.path)}
					<li class="flex items-start gap-2">
						<div class="min-w-0 flex-1">
							<code class="font-mono break-anywhere">{repair.path}</code>
							<p class="text-muted-foreground">{repair.reason}</p>
						</div>
						<Button
							size="xs"
							variant="outline"
							onclick={() => {
								void openItem(todos, repair.path, 'todos');
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
</section>
