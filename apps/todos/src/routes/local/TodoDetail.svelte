<!--
	The open todo. Its controls read the note the page holds in memory and
	write through the repository: the checkbox and the title set their
	field (`patch`), so a change made elsewhere to the rest of the note
	stays. Its notes are a view of the note's editor (`openEditor`), the one
	owner of what the person types into it: the body view and Edit source
	(the whole file, frontmatter included) are two views of one draft, so
	switching between them loses nothing. A note that does not read as a
	todo opens straight into its source, to repair, and stays there.
-->
<script lang="ts">
	import type { Editor } from '@epicenter/repository';
	import SourceEditor from '@epicenter/svelte/repository/source-editor';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { onDestroy } from 'svelte';
	import { todosApp } from '$lib/definition.js';
	import { labelOf, reportWrite, todoPath } from '$lib/local-todos.js';
	import { getRepository } from '$lib/repository.js';

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
	const note = $derived(repo.todos.get({ stem: id }));

	/**
	 * Whether the source shows instead of the todo's controls. A note that
	 * does not read as a todo turns it on, so its repair stays in the source
	 * editor once it reads as one again.
	 */
	let editingSource = $state(false);
	$effect(() => {
		if (note !== undefined && !note.valid) editingSource = true;
	});

	/** The note's editor, once open; it opens after a todo just added is stored. */
	let editor = $state.raw<Editor>();
	let destroyed = false;
	void repo.todos.openEditor({ stem: id }).then((opened) => {
		if (opened.error !== null) return;
		if (destroyed) void opened.data.close();
		else editor = opened.data;
	});
	onDestroy(() => {
		destroyed = true;
		void editor?.close().then(({ error }) => {
			if (error !== null) toast.warning('These notes are not saved yet', { description: `${error.reason}. They are kept here and saved once they can be.` });
		});
	});

	function confirmDelete(label: string) {
		confirmationDialog.open({
			title: `Delete “${label}”?`,
			description: `This deletes ${path}. Other files stay where they are.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			onConfirm() {
				void reportWrite(repo.todos.delete({ stem: id }), 'Could not delete todo');
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

{#snippet fileBar(label: string, valid: boolean)}
	<div class="flex shrink-0 items-center gap-2 border-t px-4 py-2">
		<span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" data-testid="file-path">{path}</span>
		{#if valid}
			<Button size="sm" variant="outline" onclick={() => (editingSource = !editingSource)}>
				{editingSource ? 'Open as todo' : 'Edit source'}
			</Button>
		{/if}
		<Button size="sm" variant="ghost-destructive" onclick={() => confirmDelete(label)}>Delete</Button>
	</div>
{/snippet}

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	{#if note?.valid && !editingSource}
		{@const fields = note.fields}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<Checkbox
				aria-label="Done"
				bind:checked={() => fields.done, (done) => void reportWrite(repo.todos.patch({ stem: id }, { done }), 'Could not update todo')}
			/>
			<div class="min-w-0 flex-1 space-y-2">
				<Input
					class="text-base font-medium"
					placeholder="Title"
					aria-label="Title"
					bind:value={() => fields.title, (title) => void reportWrite(repo.todos.patch({ stem: id }, { title }), 'Could not save the title')}
				/>
			</div>
		</div>
		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			{#if editor !== undefined}
				<SourceEditor {editor} shows="body" label="Notes" class="min-h-0 flex-1 rounded-md border" />
			{/if}
		</div>
		{@render fileBar(labelOf(note), true)}
	{:else if note}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<h2 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h2>
		</div>
		{#if editor !== undefined}
			<SourceEditor
				{editor}
				check={(text) => todosApp.check(text, { as: 'todos' })}
				state={note.state}
				label="Source of {path}"
				class="min-h-48 flex-1"
			/>
		{/if}
		{@render fileBar(note.valid ? labelOf(note) : `${id}.md`, note.valid)}
	{:else}
		<Empty.Root class="flex-1">
			<Empty.Title>This todo is no longer here</Empty.Title>
			<Empty.Description>It was deleted, here or on another device.</Empty.Description>
			{#if onBack}
				<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to todos</Button>
			{/if}
		</Empty.Root>
	{/if}
</section>
