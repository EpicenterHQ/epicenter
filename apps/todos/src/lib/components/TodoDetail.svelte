<!--
	The open todo: its title and notes as immediate editors (`fieldEdit`),
	whether it is done, and Delete. A note at its path that does not read as
	a todo shows its text and why, and is repaired as text (`NoteRepair`,
	saved with `replace` over the version the repair began from) or deleted.
-->
<script lang="ts">
	import { fieldEdit } from '@epicenter/svelte/client';
	import NoteRepair from '@epicenter/svelte/note-repair';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toast } from '@epicenter/ui/sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { todos as contract } from '$lib/contract.js';
	import { getTodos, labelOf, todoPath } from '$lib/todos.js';

	const todos = getTodos();
	let {
		id: shownId,
		onBack,
		onDeleted,
	}: {
		id: string;
		onBack?: () => void;
		onDeleted?: () => void;
	} = $props();

	// The parent keys this view by the todo.
	// svelte-ignore state_referenced_locally
	const id = shownId;
	const path = todoPath(id);
	const todo = $derived(todos.get({ id }));
	const invalid = $derived(todos.invalid.find((note) => note.id === id));
	const title = fieldEdit(todos, { id }, 'title');
	const body = fieldEdit(todos, { id }, 'body');

	async function toggleDone() {
		if (todo === undefined) return;
		const { error } = await todos.update({ id }, { done: !todo.done });
		if (error !== null)
			toast.error('Could not update todo', { description: error.message });
	}

	function confirmDelete(label: string) {
		const where = todos.where?.({ id }) === 'repository' ? 'your repository' : 'this device';
		confirmationDialog.open({
			title: `Delete “${label}”?`,
			description: `This deletes ${path} from ${where}.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const { error } = await todos.delete({ id });
				if (error !== null) {
					toast.error('Could not delete todo', { description: error.message });
					return;
				}
				onDeleted?.();
			},
		});
	}
</script>

{#snippet back()}
	{#if onBack}
		<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
			<ArrowLeftIcon />
		</Button>
	{/if}
{/snippet}

{#snippet fileBar(label: string)}
	<div class="flex shrink-0 items-center gap-2 border-t px-4 py-2">
		<span class="min-w-0 truncate font-mono text-xs text-muted-foreground" data-testid="file-path">{path}</span>
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => confirmDelete(label)}>Delete</Button>
	</div>
{/snippet}

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	{#if title.error !== null || body.error !== null}
		<div class="space-y-2 px-4 py-2">
			<UnsavedEdit edit={title} />
			<UnsavedEdit edit={body} />
		</div>
	{/if}
	{#if todo}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<Checkbox
				aria-label="Done"
				bind:checked={() => todo.done, () => void toggleDone()}
			/>
			<div class="min-w-0 flex-1 space-y-2">
				<Input
					class="text-base font-medium"
					placeholder="Title"
					aria-label="Title"
					bind:value={() => title.value ?? '', (value) => (title.value = value)}
				/>
			</div>
		</div>
		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none"
				placeholder="Notes in Markdown"
				aria-label="Notes"
				bind:value={() => body.value ?? '', (value) => (body.value = value)}
			/>
		</div>
		{@render fileBar(labelOf(todo))}
	{:else if invalid}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<h2 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h2>
		</div>
		<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status">
			<p class="flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				{invalid.text === null
					? 'This file is not text, so Todos cannot show it.'
					: 'This file does not read as a todo. Fix its text and save it.'}
			</p>
		</div>
		{#if invalid.text !== null}
			<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
				<NoteRepair
					{contract}
					note={invalid}
					replace={(text, options) => todos.replace({ id }, text, options)}
				/>
			</div>
		{/if}
		{@render fileBar(`${id}.md`)}
	{:else}
		<Empty.Root class="flex-1">
			<Empty.Title>This todo is no longer here</Empty.Title>
			<Empty.Description>It was deleted, here or elsewhere.</Empty.Description>
			{#if onBack}
				<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to todos</Button>
			{/if}
		</Empty.Root>
	{/if}
</section>
