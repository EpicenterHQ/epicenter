<!--
	One todo: one entry of the listing, read through `todos.rows.entry`, so it
	never disagrees with the list. Each edit goes into that cache, and this
	view's own write mutation saves it: one write at a time for this file,
	each saving whatever the cache holds when it runs. A file that does not
	read as a todo shows its text and what to fix; the text typed for it is a
	draft in the store, and Save writes it over the version it was typed over.
	Rename and delete carry the version this view shows when the person asks.
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
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { type FileCapture, type Row, wellFormed } from '@epicenter/folder';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import type { TodoFields } from '$lib/definition.js';
	import { describeError } from '$lib/describe-error.js';
	import { todoPath } from '$lib/todo-listing.js';
	import { getTodos } from '$lib/todos.svelte.js';

	const todos = getTodos();

	let {
		stem,
		onBack,
		onRenamed,
		onDeleted,
	}: {
		/** The todo shown. The parent keys this view by it. */
		stem: string;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
		/** The todo's file was renamed to `nextStem`. */
		onRenamed?: (nextStem: string) => void;
		/** The todo's file was deleted. */
		onDeleted?: () => void;
	} = $props();

	const path = $derived(todoPath(stem));
	const todo = createQuery(() => todos.rows.entry(stem).options);
	const write = createMutation(() => todos.rows.write(stem).options);
	const repair = createMutation(() => todos.rows.repair(stem).options);
	/**
	 * Edits, rename, and delete wait while this file is renamed or deleted.
	 * While Epicenter asks to leave, the page is inert and the store refuses
	 * them; this does not cover that.
	 */
	const locked = $derived(todos.rows.isMoving(stem));
	/** The repair text typed here and not saved; it lives in the store, so it outlasts this view. */
	const draft = $derived(todos.rows.draft(stem));

	/** The version this view shows, as a rename or delete carries it: a row's, or text that is not one. */
	function shown(): FileCapture | undefined {
		const result = todo.data?.result;
		if (result === undefined) return undefined;
		if (result.error === null) return { path: result.data.path, sha256: result.data.sha256 };
		if (result.error.name === 'InvalidRow') return { path: result.error.path, sha256: result.error.sha256 };
		return undefined;
	}

	/** Change the row in the cache, and queue a write when one is needed. */
	function set(change: (row: Row<TodoFields>) => Row<TodoFields>) {
		if (todos.rows.edit(stem, change)) write.mutate();
	}

	/** Write the typed text over the version it was typed over, keeping that version's line endings. */
	function saveRepair() {
		if (draft === undefined || repair.isPending) return;
		repair.mutate({ text: withFileNewlines(wellFormed(draft.text), draft.base.text), base: draft.base });
	}

	/** Textareas report LF, so views show LF; the setters restore the file's convention. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');

	const id = $props.id();
	/** The file name typed for a rename; it follows the file's name until the person types. */
	let nextName = $derived(stem);
	let renaming = $state(false);

	async function rename(event: SubmitEvent) {
		event.preventDefault();
		const name = nextName;
		const version = shown();
		if (locked || renaming || name === stem || version === undefined) return;
		renaming = true;
		const { error } = await todos.rows.rename(stem, name, version);
		renaming = false;
		if (error !== null) toast.error('Could not rename the file', { description: describeError(error) });
		else onRenamed?.(name);
	}

	/** What deleting this file loses, as Git status reports it now. */
	async function history() {
		const { data: observed } = await todos.git.status.fetch();
		if (observed === null)
			return 'Todos could not check whether its latest changes are in a saved version, so they may be lost.';
		return observed.changes.some((change) => change.path === path)
			? 'Its latest changes are in no saved version, so deleting it loses them. Save a version first to keep them in history.'
			: 'Its current text is in the last saved version.';
	}

	/**
	 * Ask before deleting this file, named by its title when it has one. The
	 * delete carries the version shown when the dialog opens: it runs after
	 * the file's queued writes, and only on that version or one this app
	 * wrote from it since.
	 */
	async function confirmDelete(title: string | undefined) {
		const lost = await history();
		const version = shown();
		if (version === undefined) return;
		confirmationDialog.open({
			title: `Delete “${title?.trim() ? title : `${stem}.md`}”?`,
			description: `This deletes ${path} from the folder. ${lost}`,
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const { error } = await todos.rows.remove(stem, version);
				if (error !== null) toast.error(`Could not delete ${path}`, { description: describeError(error) });
				else onDeleted?.();
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

{#snippet nameBar(title?: string)}
	<form class="flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-2" onsubmit={rename}>
		<label class="text-xs text-muted-foreground" for={id}>File name</label>
		<div class="flex min-w-0 items-center gap-1">
			<span class="font-mono text-xs text-muted-foreground">todos/</span>
			<Input {id} class="h-8 w-44 font-mono md:text-xs" bind:value={nextName} autocomplete="off" spellcheck={false} disabled={locked} />
			<span class="font-mono text-xs text-muted-foreground">.md</span>
		</div>
		<Button type="submit" size="sm" variant="outline" disabled={locked || renaming || nextName === stem}>
			Rename file
		</Button>
		<Button class="ml-auto" size="sm" variant="ghost-destructive" disabled={locked} onclick={() => void confirmDelete(title)}>Delete</Button>
	</form>
{/snippet}

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	{#if todo.data?.result.error === null}
		{@const row = todo.data.result.data.row}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<Checkbox
				aria-label="Done"
				disabled={locked}
				bind:checked={() => row.fields.done, (done) => set((r) => ({ ...r, fields: { ...r.fields, done } }))}
			/>
			<Input
				class="flex-1 text-base font-medium"
				placeholder="Title"
				aria-label="Title"
				disabled={locked}
				bind:value={
					() => row.fields.title,
					(title) => set((r) => ({ ...r, fields: { ...r.fields, title: wellFormed(title) } }))
				}
			/>
		</div>

		<p class="shrink-0 border-b px-4 py-1 text-xs text-muted-foreground" role="status" data-testid="write-status">
			{write.isPending ? 'Saving…' : `Saved to ${path}`}
		</p>

		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none"
				placeholder="Notes in Markdown"
				aria-label="Notes"
				disabled={locked}
				bind:value={
					() => lf(row.body),
					(notes) => set((r) => ({ ...r, body: withFileNewlines(wellFormed(notes), r.body) }))
				}
			/>
		</div>

		{@render nameBar(row.fields.title)}
	{:else if todo.data?.result.error?.name === 'InvalidRow'}
		{@const error = todo.data.result.error}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<h2 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h2>
		</div>
		<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				This file does not read as a todo. Fix its text here and save.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each error.issues as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		</div>
		{#if draft !== undefined && draft.base.sha256 !== error.sha256}
			<p class="shrink-0 border-b bg-warning/10 px-4 py-2 text-xs" role="status" data-testid="repair-stale">
				This file changed elsewhere since you started typing, so Save will change nothing and offer to copy your text. Discard shows the file as it is now.
			</p>
		{/if}
		<form
			class="flex min-h-48 flex-1 flex-col gap-2 px-3 py-3 sm:px-4"
			onsubmit={(event) => {
				event.preventDefault();
				saveRepair();
			}}
		>
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none font-mono text-xs"
				aria-label="Text of {path}"
				spellcheck={false}
				disabled={locked || repair.isPending}
				bind:value={() => draft?.text ?? lf(error.text), (typed) => todos.rows.setDraft(stem, typed)}
			/>
			<div class="flex items-center justify-end gap-2">
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={locked || repair.isPending || draft === undefined}
					onclick={() => todos.rows.discardDraft(stem)}
				>
					Discard
				</Button>
				<Button type="submit" size="sm" disabled={locked || repair.isPending || draft === undefined}>
					{repair.isPending ? 'Saving…' : 'Save'}
				</Button>
			</div>
		</form>
		{@render nameBar()}
	{:else if todo.data?.result.error}
		<Empty.Root class="flex-1">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not read this todo</Empty.Title>
			<Empty.Description>{todo.data.result.error.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void todos.refresh()}>Try again</Button>
		</Empty.Root>
	{:else if todo.isSuccess}
		<Empty.Root class="flex-1">
			<Empty.Title>This todo is no longer in the folder</Empty.Title>
			<Empty.Description>It was renamed or deleted, here or by another program.</Empty.Description>
			{#if onBack}
				<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to todos</Button>
			{/if}
		</Empty.Root>
	{:else if todo.isError}
		<Empty.Root class="flex-1">
			<Empty.Title>Could not read the todos folder</Empty.Title>
			<Empty.Description>{todo.error.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void todos.refresh()}>Try again</Button>
		</Empty.Root>
	{:else}
		<Loading class="flex-1" label="Opening the todo…" />
	{/if}
</section>
