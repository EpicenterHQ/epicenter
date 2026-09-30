<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import type { TodoEntry } from '$lib/editor.svelte.js';
	import type { Todos } from '$lib/todos.svelte.js';

	let { todos, onOpen }: { todos: Todos; onOpen?: () => void } = $props();
	let draft = $state('');
	let adding = $state(false);

	function titleOf(entry: TodoEntry) {
		const title = entry.fields.title;
		if (typeof title === 'string' && title.trim() !== '') return title;
		return entry.stem ?? entry.path;
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		const title = draft.trim();
		if (title === '' || adding) return;
		adding = true;
		const problem = await todos.create(title);
		adding = false;
		if (problem) toast.error('Could not add the todo', { description: problem });
		else draft = '';
	}

	async function toggle(entry: TodoEntry) {
		const problem = await todos.toggle(entry);
		if (problem) toast.error('Could not change the todo', { description: problem });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo list">
	<form class="border-b p-3" onsubmit={add}>
		<Input
			bind:value={draft}
			placeholder="Add a todo and press Enter"
			aria-label="New todo title"
			disabled={adding}
		/>
	</form>

	{#if todos.listError}
		<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
			Could not read the todos folder: {todos.listError}. Showing the last list that was read.
		</p>
	{/if}

	<ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Todos">
		{#each todos.entries as entry (entry.path)}
			{@const selected = todos.selectedPath === entry.path}
			{@const done = entry.fields.done === true}
			<li
				class="flex items-center gap-3 border-b px-3 py-2 text-sm {selected
					? 'bg-accent text-accent-foreground'
					: 'hover:bg-muted/50'}"
			>
				<Checkbox
					checked={done}
					disabled={typeof entry.fields.done !== 'boolean'}
					aria-label={done ? 'Mark as not done' : 'Mark as done'}
					onCheckedChange={() => void toggle(entry)}
				/>
				<button
					type="button"
					class="flex min-h-8 min-w-0 flex-1 items-center gap-2 text-left"
					aria-current={selected ? 'true' : undefined}
					data-todo={entry.path}
					onclick={() => {
						void todos.open(entry.path);
						onOpen?.();
					}}
				>
					<span class="truncate {done ? 'text-muted-foreground line-through' : ''}">{titleOf(entry)}</span>
					{#if entry.issues}
						<Badge variant="destructive" class="shrink-0">Needs repair</Badge>
					{/if}
				</button>
				<span class="shrink-0 font-mono text-xs text-muted-foreground max-sm:hidden">{entry.stem ?? entry.path}</span>
			</li>
		{:else}
			<li class="px-3 py-8 text-center text-sm text-muted-foreground">
				No todos yet. Add one above, pull from the remote, or create
				<code class="font-mono">todos/&lt;name&gt;.md</code> in the terminal.
			</li>
		{/each}
	</ul>

	{#if todos.unreadable.length > 0}
		<div class="border-t bg-warning/10 px-3 py-2 text-xs">
			<p class="font-medium">Files that could not be read as text</p>
			<ul class="mt-1 space-y-0.5">
				{#each todos.unreadable as item (item.path)}
					<li><code class="font-mono">{item.path}</code>: {item.message}</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>
