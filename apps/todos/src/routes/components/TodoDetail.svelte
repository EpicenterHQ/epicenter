<!--
	One todo's fields and notes. The view reads the todo listing narrowed to
	this row, so it never disagrees with the list. Each edit goes into that
	cache, and this view's own write mutation saves it: one write at a time
	for this file, each saving whatever the cache holds when it runs.
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
	import { confirmDelete } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';

	const todos = getTodos();

	let {
		stem,
		onBack,
	}: {
		/** The todo shown. The parent keys this view by it. */
		stem: string;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	const path = $derived(todoPath(stem));
	const todo = createQuery(() =>
		todos.rowsQuery((listing) => listing.find((entry) => entry.stem === stem)),
	);
	const write = createMutation(() => todos.rowWrite(stem));
	/** Edits wait while Epicenter asks to leave, and while this file is renamed or deleted. */
	const locked = $derived(todos.isMoving(path));

	/** Change the row in the cache, and queue a write when one is needed. */
	function set(change: (row: Row<TodoFields>) => Row<TodoFields>) {
		if (todos.edit(stem, change)) write.mutate();
	}

	/** Textareas report LF, so views show LF; the notes setter restores the file's convention. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');
</script>

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	{#if todo.data?.result.error === null}
		{@const row = todo.data.result.data.row}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{#if onBack}
				<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
					<ArrowLeftIcon />
				</Button>
			{/if}
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
			<Button size="sm" variant="outline" onclick={() => todos.select(path, 'files')}>
				Open in Files
			</Button>
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

		<FileNameBar
			prefix="todos/"
			name={stem}
			suffix=".md"
			onRename={async (next) => {
				const { error } = await todos.rename(path, `${next}.md`);
				return error === null ? undefined : describeError(error);
			}}
			onDelete={() => void confirmDelete(todos, path)}
		/>
	{:else if todo.data?.result.error}
		{@const error = todo.data.result.error}
		<Empty.Root class="flex-1" data-testid="needs-repair">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			{#if error.name === 'InvalidRow'}
				<Empty.Title><Badge variant="destructive">Needs repair</Badge> This file does not read as a todo</Empty.Title>
				<Empty.Description>
					<code class="font-mono">{path}</code>: {error.issues.map((issue) => issue.message).join(' ')}
				</Empty.Description>
				<Button variant="outline" size="sm" onclick={() => todos.select(path, 'repair')}>Repair as text</Button>
			{:else}
				<Empty.Title>Could not read this todo</Empty.Title>
				<Empty.Description>{error.message}</Empty.Description>
				<Button variant="outline" size="sm" onclick={() => void todos.refresh()}>Try again</Button>
			{/if}
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
