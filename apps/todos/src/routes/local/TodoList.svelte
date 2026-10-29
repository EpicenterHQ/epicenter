<!--
	The todo list over this device's repository: adding a todo, the notes
	that read as todos, and the ones that do not, each with its file and why.
	The list reads the todos the page holds in memory, so it follows every
	change here and elsewhere.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { getRepository } from '$lib/repository.js';
	import { repairsOf, reportWrite, todoPath, todosOf } from '$lib/local-todos.js';
	import TodoRow from './TodoRow.svelte';

	const repo = getRepository();

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

	const notes = $derived(repo.todos.all());
	const todos = $derived(todosOf(notes));
	const repairs = $derived(repairsOf(notes));

	/** Add the todo and open it: it shows at once, and its detail opens once it is stored. */
	function add() {
		const typed = title.trim();
		if (typed === '') return;
		const id = crypto.randomUUID();
		void reportWrite(repo.todos.create({ stem: id }, { fields: { title: typed, done: false } }), 'Could not add todo');
		title = '';
		onOpen?.(id);
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo list">
	<form
		class="flex shrink-0 items-center gap-2 border-b p-3"
		onsubmit={(event) => {
			event.preventDefault();
			add();
		}}
	>
		<Input bind:value={title} placeholder="Add a todo" aria-label="New todo title" />
		<Button type="submit" disabled={title.trim() === ''}>Add</Button>
	</form>

	<div class="flex min-h-0 flex-1 flex-col">
		<ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Todos">
			{#each todos as todo (todo.path)}
				<TodoRow {todo} selected={open === todo.params.stem} {onOpen} />
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
			<!-- Not todos the list can edit: each opens into its source, to repair. -->
			<section class="max-h-[40%] shrink-0 overflow-y-auto border-t bg-destructive/5 px-3 py-2 text-xs" aria-label="Needs repair">
				<p class="flex items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					{repairs.length === 1 ? 'This file does' : 'These files do'} not read as a todo.
				</p>
				<ul class="mt-1 space-y-1.5">
					{#each repairs as repair (repair.path)}
						<li class="flex items-start gap-2">
							<div class="min-w-0 flex-1">
								<code class="font-mono break-anywhere">{todoPath(repair.params.stem)}</code>
								<p class="text-muted-foreground">{repair.issues.join('; ')}</p>
							</div>
							<Button
								size="xs"
								variant="outline"
								aria-current={open === repair.params.stem ? 'true' : undefined}
								onclick={() => onOpen?.(repair.params.stem)}
							>
								Repair
							</Button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
</section>
