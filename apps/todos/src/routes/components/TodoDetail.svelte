<!--
	One todo: one entry of the listing, read through `todos.rows.entry`, so it
	never disagrees with the list. The parent keys this view by the todo, so a
	pending save always lands on the todo it was typed into (ADR-0554).

	The done checkbox sends its change at once and shows the file. The title
	is held in this view's state while typed, sent a second after the last
	keystroke, and sent at once when the person leaves the field or the view
	goes away; the typed value clears once its save lands with nothing typed
	since. Each is an update of the file as it is now, so neither undoes the
	other or another writer's change to another field. The notes are a
	document: a body draft that keeps the version it started from, saved on
	the same pause and merged by line with whatever changed since.

	A file that does not read as a todo shows its text and what to fix,
	read-only: another editor fixes it, and the folder's change report shows
	the result. Delete carries the version this view shows when the person
	asks. Todos does not rename files; the file system, Git, or another
	program does.
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
	import { createBodyEditor } from '@epicenter/folder/svelte';
	import { createMutation, createQuery, useIsMutating } from '@tanstack/svelte-query';
	import { useDebounce } from 'runed';
	import { onDestroy } from 'svelte';
	import type { TodoFields } from '$lib/definition.js';
	import { describeError } from '$lib/describe-error.js';
	import { todosKeys } from '$lib/session.js';
	import { todoPath } from '$lib/todo-listing.js';
	import { getTodos } from '$lib/todos.svelte.js';

	const todos = getTodos();

	let {
		stem: shownStem,
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

	// The parent keys this view by the todo. While the parent replaces it,
	// the prop already reads the next todo, so this view keeps its own: a
	// save sent as it goes away lands on the todo it was typed into.
	// svelte-ignore state_referenced_locally
	const stem = shownStem;
	const path = todoPath(stem);
	const todo = createQuery(() => todos.rows.entry(stem));
	const saveDone = createMutation(() => todos.rows.update);
	const saveTitle = createMutation(() => todos.rows.update);
	const saveNotes = createMutation(() => todos.rows.saveNotes);
	/** The row as the cache holds it, when the file reads as a todo. */
	const stored = $derived(todo.data?.result.error === null ? todo.data.result.data : undefined);
	/**
	 * Edits and delete wait while this file is deleted. While Epicenter asks
	 * to leave, the page is inert and the store refuses them; this does not
	 * cover that.
	 */
	// svelte-ignore state_referenced_locally
	const deleting = useIsMutating({ mutationKey: todosKeys.remove(path) });
	const locked = $derived(deleting.current > 0);

	/** The title typed and not yet saved; `undefined` shows the file. */
	let title = $state<string>();
	function sendTitle() {
		if (title === undefined) return;
		const sent = title;
		saveTitle.mutate(
			{ stem, set: { title: sent } },
			{
				onSuccess: () => {
					if (title === sent) title = undefined;
				},
			},
		);
	}
	const sendTitleLater = useDebounce(sendTitle, 1000);

	/** The notes: the body, opened with the version it started from (ADR-0575). */
	const notes = createBodyEditor<TodoFields>({
		row: () => stored,
		save: (variables) => saveNotes.mutateAsync(variables),
	});
	const sendNotesLater = useDebounce(() => notes.save(), 1000);

	/** Send what is typed now, as leaving the field does. */
	function flush() {
		void sendTitleLater.runScheduledNow();
		void sendNotesLater.runScheduledNow();
	}
	// runed's timers outlive the view; send now instead.
	onDestroy(flush);

	const pending = $derived(
		saveDone.isPending ||
			saveTitle.isPending ||
			notes.saving ||
			(sendTitleLater.pending && title !== undefined) ||
			(sendNotesLater.pending && notes.typed !== undefined),
	);
	/** Why typed text is not in the file, while it is still typed. */
	const failure = $derived(
		title !== undefined && saveTitle.error
			? saveTitle.error
			: notes.typed !== undefined && saveNotes.error
				? saveNotes.error
				: undefined,
	);

	function tryAgain() {
		sendTitle();
		void notes.save();
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
	 * dialog opens once what is typed here and every running save have
	 * landed, on the version they left, and the delete runs only on that
	 * version.
	 */
	async function confirmDelete(shownTitle: string | undefined) {
		await Promise.all([sendTitleLater.runScheduledNow(), sendNotesLater.runScheduledNow()]);
		await notes.save();
		const version = await todos.rows.shown(stem);
		const lost = await history();
		if (version === undefined) return;
		confirmationDialog.open({
			title: `Delete “${shownTitle?.trim() ? shownTitle : `${stem}.md`}”?`,
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
		{@const shownTitle = title ?? stored.row.fields.title}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<Checkbox
				aria-label="Done"
				disabled={locked}
				bind:checked={
					() => stored.row.fields.done,
					(done) =>
						saveDone.mutate({ stem, set: { done } })
				}
			/>
			<Input
				class="flex-1 text-base font-medium"
				placeholder="Title"
				aria-label="Title"
				disabled={locked}
				bind:value={
					() => shownTitle,
					(typed) => {
						title = typed;
						void sendTitleLater();
					}
				}
				onblur={() => void sendTitleLater.runScheduledNow()}
			/>
		</div>

		<p class="shrink-0 border-b px-4 py-1 text-xs text-muted-foreground" role="status" data-testid="write-status">
			{#if pending}
				Saving…
			{:else if failure}
				Not saved: {describeError(failure)}
				<Button variant="link" size="xs" class="h-auto p-0" onclick={tryAgain}>Try again</Button>
			{:else}
				Saved to {path}
			{/if}
		</p>

		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none"
				placeholder="Notes in Markdown"
				aria-label="Notes"
				disabled={locked}
				bind:value={
					() => notes.text ?? '',
					(typed) => {
						notes.change(typed);
						void sendNotesLater();
					}
				}
				onblur={() => void sendNotesLater.runScheduledNow()}
			/>
		</div>

		{@render fileBar(shownTitle)}
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
			aria-label="Text of {path}">{error.text}</pre>
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
