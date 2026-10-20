<!--
	One todo over this browser's local folder: one row of the rows query, so
	it never disagrees with the list. The parent keys this view by the todo,
	so a save sent as it goes away lands on the todo it was typed into.

	The title, done, and notes are the row's draft (`edits.row`): what is
	typed shows at once and saves a second after the last keystroke, at once
	when the person leaves the field, ticks the checkbox, or the view goes
	away. A reread never replaces it. Each save merges with whatever was
	saved meanwhile, here or in another tab. A save that fails keeps the
	typing and offers Try again.

	A row that does not read as a todo shows its text and issues, read-only.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { getFolder } from '$lib/folder.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { describeFailure, labelOf, type TodoRow, todoPath } from '$lib/local-todos.js';

	const { queries, edits } = getFolder();

	let {
		id: shownId,
		onBack,
		onDeleted,
	}: {
		/** The todo shown. The parent keys this view by it. */
		id: string;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
		/** The todo was deleted. */
		onDeleted?: () => void;
	} = $props();

	// The parent keys this view by the todo. While the parent replaces it,
	// the prop already reads the next todo, so this view keeps its own.
	// svelte-ignore state_referenced_locally
	const id = shownId;
	const path = todoPath(id);
	const row = createQuery(() => ({
		...queries.rows('todos'),
		select: (rows: TodoRow[]) => rows.find((candidate) => candidate.id === id),
	}));
	const draft = edits.row('todos', id);
	/** The row as stored, when it reads as a todo. */
	const stored = $derived(row.data?.issues === null ? row.data : undefined);

	// The draft outlives the view; send what is typed now.
	onDestroy(() => void draft.save());

	function confirmDiscard() {
		confirmationDialog.open({
			title: 'Discard unsaved changes?',
			description: `Copy any changes you need from ${path} before discarding them. Saved source remains on this device.`,
			confirm: { text: 'Discard changes', variant: 'destructive' },
			onConfirm: () => { draft.discard(); },
		});
	}

	/**
	 * Ask before deleting the todo, named by its title. What is typed is sent
	 * first. The delete removes the todo as it is stored when it runs; one
	 * changed in that moment is kept.
	 */
	async function confirmDelete(label: string) {
		await draft.save();
		confirmationDialog.open({
			title: `Delete “${label}”?`,
			description: `This deletes ${path} from this device. Other files stay in the folder.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const { data, error } = await edits.delete('todos', id);
				if (error !== null) toast.error(`Could not delete ${path}`, { description: describeFailure(error) });
				else if (data.deleted || row.data === undefined) onDeleted?.();
				else toast.error(`${path} was not deleted`, { description: 'It changed while it was deleted, so it was kept.' });
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
		{#if row.data?.issues?.some((issue) => issue.kind === 'not-text')}
			<span class="ml-auto text-xs text-muted-foreground">Open this file elsewhere to remove it</span>
		{:else}
			<Button class="ml-auto" size="sm" variant="ghost-destructive" disabled={draft.locked} onclick={() => void confirmDelete(label)}>Delete</Button>
		{/if}
	</div>
{/snippet}

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	{#if row.isError}
		<div class="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive" role="status">
			Could not read the latest todo: {row.error.message}.
			<Button variant="link" size="xs" onclick={() => void row.refetch()}>Try again</Button>
		</div>
	{/if}
	{#if !stored && draft.pending}
		<div class="border-b bg-destructive/10 px-4 py-2 text-xs" role="status" data-testid="held-draft">
			<p>Unsaved changes for {path} are still here. Select and copy them before closing this tab if saving keeps failing.</p>
			{#if draft.error}<p>Not saved: {describeFailure(draft.error)}</p>{/if}
			<pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap select-text" aria-label="Unsaved changes">{JSON.stringify({ fields: draft.pending.fields, body: draft.pending.body }, null, 2)}</pre>
			<Button variant="outline" size="xs" onclick={() => void draft.save()}>Try saving again</Button>
			<Button variant="ghost-destructive" size="xs" onclick={confirmDiscard}>Discard changes</Button>
		</div>
	{/if}
	{#if stored}
		{@const shown = draft.shown(stored)}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<Checkbox
				aria-label="Done"
				disabled={draft.locked}
				bind:checked={
					() => shown.fields.done,
					(done) => {
						if (stored !== undefined && draft.change(stored, { fields: { done } }))
							void draft.save();
					}
				}
			/>
			<Input
				class="flex-1 text-base font-medium"
				placeholder="Title"
				aria-label="Title"
				disabled={draft.locked}
				bind:value={
					() => shown.fields.title,
					(title) => {
						if (stored !== undefined) draft.change(stored, { fields: { title } });
					}
				}
				onblur={() => void draft.save()}
			/>
		</div>

		<p class="shrink-0 border-b px-4 py-1 text-xs text-muted-foreground" role="status" data-testid="write-status">
			{#if draft.error && !draft.saving}
				Not saved: {describeFailure(draft.error)}
				<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void draft.save()}>Try again</Button>
				<Button variant="link" size="xs" class="h-auto p-0" onclick={confirmDiscard}>Discard changes</Button>
			{:else if draft.held}
				Saving…
			{:else}
				Saved on this device
			{/if}
		</p>

		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none"
				placeholder="Notes in Markdown"
				aria-label="Notes"
				disabled={draft.locked}
				bind:value={
					() => shown.body,
					(body) => {
						if (stored !== undefined) draft.change(stored, { body });
					}
				}
				onblur={() => void draft.save()}
			/>
		</div>

		{@render fileBar(labelOf(shown))}
	{:else if row.data}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<h2 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h2>
		</div>
		<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				{row.data.issues?.some((issue) => issue.kind === 'not-text')
					? 'This file is not text. Todos leaves its bytes untouched.'
					: 'This file does not read as a todo. Todos keeps its text as it is.'}
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each row.data.issues ?? [] as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		</div>
		<pre
			class="min-h-48 flex-1 overflow-auto px-4 py-3 font-mono text-xs break-words whitespace-pre-wrap"
			aria-label="Text of {path}">{row.data.text}</pre>
		{@render fileBar(`${id}.md`)}
	{:else if row.isSuccess}
		<Empty.Root class="flex-1">
			<Empty.Title>This todo is no longer here</Empty.Title>
			<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
			{#if onBack}
				<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to todos</Button>
			{/if}
		</Empty.Root>
	{:else if row.isError}
		<Empty.Root class="flex-1">
			<Empty.Title>Could not read your todos</Empty.Title>
			<Empty.Description>{row.error.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void row.refetch()}>Try again</Button>
		</Empty.Root>
	{:else}
		<Loading class="flex-1" label="Opening the todo…" />
	{/if}
</section>
