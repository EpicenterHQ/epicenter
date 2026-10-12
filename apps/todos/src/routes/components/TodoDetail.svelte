<!--
	One todo: one row of the listing. The view reads the todo listing narrowed
	to this row, so it never disagrees with the list. Each edit goes into that
	cache, and this view's own write mutation saves it: one write at a time
	for this file, each saving whatever the cache holds when it runs. A file
	that does not read as a todo shows its text and what to fix, and Save
	writes the text typed here over it.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { type Row, wellFormed } from '@epicenter/folder';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import type { TodoFields } from '$lib/definition.js';
	import { describeError } from '$lib/describe-error.js';
	import { todoPath } from '$lib/todo-listing.js';
	import { getTodos } from '$lib/todos.svelte.js';
	import { confirmDelete } from './actions.js';
	import FileNameBar from './FileNameBar.svelte';

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
	const todo = createQuery(() =>
		({ ...todos.rows.list.options, select: (listing) => listing.find((entry) => entry.stem === stem) }),
	);
	const write = createMutation(() => todos.rows.write(stem).options);
	const repair = createMutation(() => todos.rows.repair(stem).options);
	/** Edits wait while Epicenter asks to leave, and while this file is renamed or deleted. */
	const locked = $derived(todos.rows.isMoving(stem));
	/**
	 * The repair text typed here, once the person types. Until then the
	 * textarea shows the file's text. Text that is not a todo yet is the
	 * point of this field, so it lives here, not in the cache.
	 */
	let draft = $state<string | undefined>();

	/** Change the row in the cache, and queue a write when one is needed. */
	function set(change: (row: Row<TodoFields>) => Row<TodoFields>) {
		if (todos.rows.edit(stem, change)) write.mutate();
	}

	/** Write the typed text over the file, keeping its line endings. */
	function saveRepair(fileText: string) {
		if (draft === undefined || repair.isPending) return;
		repair.mutate(withFileNewlines(wellFormed(draft), fileText), {
			onSuccess: () => {
				draft = undefined;
			},
		});
	}

	/** Textareas report LF, so views show LF; the setters restore the file's convention. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');
</script>

{#snippet back()}
	{#if onBack}
		<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
			<ArrowLeftIcon />
		</Button>
	{/if}
{/snippet}

{#snippet nameBar(title?: string)}
	<FileNameBar
		prefix="todos/"
		name={stem}
		suffix=".md"
		onRename={async (next) => {
			const { error } = await todos.rows.rename(stem, next);
			if (error !== null) return describeError(error);
			onRenamed?.(next);
			return undefined;
		}}
		onDelete={() => void confirmDelete(todos, stem, title, onDeleted)}
	/>
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
		<form
			class="flex min-h-48 flex-1 flex-col gap-2 px-3 py-3 sm:px-4"
			onsubmit={(event) => {
				event.preventDefault();
				saveRepair(error.text);
			}}
		>
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none font-mono text-xs"
				aria-label="Text of {path}"
				spellcheck={false}
				disabled={locked}
				bind:value={() => draft ?? lf(error.text), (typed) => (draft = typed)}
			/>
			<Button class="self-end" type="submit" size="sm" disabled={locked || repair.isPending || draft === undefined}>
				{repair.isPending ? 'Saving…' : 'Save'}
			</Button>
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
