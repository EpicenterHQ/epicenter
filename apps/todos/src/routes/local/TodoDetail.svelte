<!--
	The open todo, held open in the repository: its controls read the note
	synchronously and write through it, so what a person types shows at
	once and changes from elsewhere arrive while it is open. Edit source
	opens the todo's whole file, frontmatter included, in the source editor;
	a note that does not read as a todo opens straight into it, to repair.
-->
<script lang="ts">
	import { opened } from '@epicenter/repository/svelte';
	import SourceEditor from '@epicenter/svelte/source-editor';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { onDestroy } from 'svelte';
	import { getRepository } from '$lib/repository.js';
	import { labelOf, reportWrite, todoPath } from '$lib/local-todos.js';

	const repo = getRepository();
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
	/**
	 * Whether the source shows instead of the todo's controls. A note that
	 * does not read as a todo turns it on, so its repair stays in the source
	 * editor once it reads as one again.
	 */
	let editingSource = $state(false);
	// Closed as this view goes, so the note never calls back into it afterward.
	let held: { close(): void } | undefined;
	let destroyed = false;
	const opening = repo.todos.open({ stem: id }).then((note) => {
		if (destroyed) note.close();
		else held = note;
		const toRepair = (shown: ReturnType<typeof note.read>) => {
			if (shown !== null && !shown.valid) editingSource = true;
		};
		toRepair(note.read());
		note.subscribe(toRepair);
		return opened(note);
	});
	onDestroy(() => {
		destroyed = true;
		held?.close();
	});

	function confirmDelete(todo: Awaited<typeof opening>, label: string) {
		confirmationDialog.open({
			title: `Delete “${label}”?`,
			description: `This deletes ${path}. Other files stay where they are.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			onConfirm() {
				void reportWrite(todo.delete(), 'Could not delete todo');
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

{#snippet fileBar(todo: Awaited<typeof opening>, label: string, valid: boolean)}
	<div class="flex shrink-0 items-center gap-2 border-t px-4 py-2">
		<span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" data-testid="file-path">{path}</span>
		{#if valid}
			<Button size="sm" variant="outline" onclick={() => (editingSource = !editingSource)}>
				{editingSource ? 'Open as todo' : 'Edit source'}
			</Button>
		{/if}
		<Button size="sm" variant="ghost-destructive" onclick={() => confirmDelete(todo, label)}>Delete</Button>
	</div>
{/snippet}

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	{#await opening then todo}
		{@const note = todo.current}
		{#if note?.valid && !editingSource}
			<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
				{@render back()}
				<Checkbox
					aria-label="Done"
					bind:checked={() => note.fields.done, (done) => void reportWrite(todo.set('done', done), 'Could not update todo')}
				/>
				<div class="min-w-0 flex-1 space-y-2">
					<Input
						class="text-base font-medium"
						placeholder="Title"
						aria-label="Title"
						bind:value={() => note.fields.title, (title) => void reportWrite(todo.set('title', title), 'Could not save the title')}
					/>
				</div>
			</div>
			<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
				<Textarea
					class="min-h-0 flex-1 field-sizing-fixed resize-none"
					placeholder="Notes in Markdown"
					aria-label="Notes"
					bind:value={() => note.body, (body) => void reportWrite(todo.write({ body }), 'Could not save the notes')}
				/>
			</div>
			{@render fileBar(todo, labelOf(note), true)}
		{:else if note}
			<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
				{@render back()}
				<h2 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h2>
			</div>
			<SourceEditor {repo} {path} lens="todos" label="Source of {path}" class="min-h-48 flex-1" />
			{@render fileBar(todo, note.valid ? labelOf(note) : `${id}.md`, note.valid)}
		{:else}
			<Empty.Root class="flex-1">
				<Empty.Title>This todo is no longer here</Empty.Title>
				<Empty.Description>It was deleted, here or on another device.</Empty.Description>
				{#if onBack}
					<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to todos</Button>
				{/if}
			</Empty.Root>
		{/if}
	{/await}
</section>
