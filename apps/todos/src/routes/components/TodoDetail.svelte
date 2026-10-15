<!--
	One todo: one entry of the listing, read through `todos.rows.entry`, so it
	never disagrees with the list. An edit is this view's draft: it starts
	from the row shown at the first change, and a read that lands meanwhile
	updates the list, never the draft. Saves run one at a time, and a file
	changed elsewhere is merged with the edit. A file that does not read as a
	todo shows its text and what to fix, read-only: another editor fixes it,
	and the folder's change report shows the result. Delete carries the
	version this view shows when the person asks. Todos does not rename
	files; the file system, Git, or another program does.
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
	import { type Row, wellFormed } from '@epicenter/folder';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { createDraftState } from '@epicenter/folder/svelte';
	import { toastReplaced } from '@epicenter/svelte/replaced-notice';
	import { createMutation, createQuery, useIsMutating } from '@tanstack/svelte-query';
	import type { TodoFields } from '$lib/definition.js';
	import { describeError } from '$lib/describe-error.js';
	import { todosKeys } from '$lib/session.js';
	import { todoPath } from '$lib/todo-listing.js';
	import { getTodos } from '$lib/todos.svelte.js';

	const todos = getTodos();

	let {
		stem,
		onBack,
		onDeleted,
	}: {
		/** The todo shown. The parent keys this view by it. */
		stem: string;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
		/** The todo's file was deleted. */
		onDeleted?: () => void;
	} = $props();

	const path = $derived(todoPath(stem));
	const todo = createQuery(() => todos.rows.entry(stem));
	const save = createMutation(() => todos.rows.save);
	const draft = createDraftState<TodoFields>({
		save: (sent) => save.mutateAsync(sent),
		// Name what a save replaced of another writer's change, and offer it back.
		onSaved: ({ replaced, stored }, restore) =>
			void toastReplaced({ replaced, subject: stored.row.fields.title, restore }),
	});
	/** The row as the cache holds it, when the file reads as a todo. */
	const stored = $derived(todo.data?.result.error === null ? todo.data.result.data : undefined);
	/**
	 * Edits and delete wait while this file is deleted. While Epicenter asks
	 * to leave, the page is inert and the store refuses them; this does not
	 * cover that.
	 */
	// svelte-ignore state_referenced_locally
	const deleting = useIsMutating({ mutationKey: todosKeys.remove(todoPath(stem)) });
	const locked = $derived(deleting.current > 0);

	/** Change the draft, starting it from the row shown, and save. */
	function set(edit: (row: Row<TodoFields>) => void) {
		if (stored === undefined || locked) return;
		draft.change(stored, edit);
		void draft.save();
	}

	/** Textareas report LF, so views show LF; the setters restore the file's convention. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');

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
	 * dialog opens once this view's draft and every running save have landed,
	 * on the version they left, and the delete runs only on that version.
	 */
	async function confirmDelete(title: string | undefined) {
		await draft.save();
		const version = await todos.rows.shown(stem);
		const lost = await history();
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

{#snippet fileBar(title?: string)}
	<div class="flex shrink-0 items-center gap-2 border-t px-4 py-2">
		<span class="min-w-0 truncate font-mono text-xs text-muted-foreground" data-testid="file-path">{path}</span>
		<Button class="ml-auto" size="sm" variant="ghost-destructive" disabled={locked} onclick={() => void confirmDelete(title)}>Delete</Button>
	</div>
{/snippet}

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	{#if stored}
		{@const row = draft.row ?? stored.row}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<Checkbox
				aria-label="Done"
				disabled={locked}
				bind:checked={() => row.fields.done, (done) => set((r) => { r.fields.done = done; })}
			/>
			<Input
				class="flex-1 text-base font-medium"
				placeholder="Title"
				aria-label="Title"
				disabled={locked}
				bind:value={
					() => row.fields.title,
					(title) => set((r) => { r.fields.title = wellFormed(title); })
				}
			/>
		</div>

		<p class="shrink-0 border-b px-4 py-1 text-xs text-muted-foreground" role="status" data-testid="write-status">
			{#if draft.saving}
				Saving…
			{:else if draft.row && save.error}
				Not saved: {describeError(save.error)}
				<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void draft.save()}>Try again</Button>
			{:else}
				Saved to {path}
			{/if}
			{#if draft.changedElsewhere(stored)}
				Changed elsewhere; your edit will be merged.
			{/if}
		</p>

		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none"
				placeholder="Notes in Markdown"
				aria-label="Notes"
				disabled={locked}
				bind:value={
					() => lf(row.body),
					(notes) => set((r) => { r.body = withFileNewlines(wellFormed(notes), r.body); })
				}
			/>
		</div>

		{@render fileBar(row.fields.title)}
	{:else if todo.data?.result.error?.name === 'InvalidRow'}
		{@const error = todo.data.result.error}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<h2 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h2>
		</div>
		<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				This file does not read as a todo. Fix it in a text editor; Todos shows the fixed file.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each error.issues as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		</div>
		<pre
			class="min-h-48 flex-1 overflow-auto px-4 py-3 font-mono text-xs break-words whitespace-pre-wrap"
			aria-label="Text of {path}">{lf(error.text)}</pre>
		{@render fileBar()}
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
