<!--
	One capture file as its exact Markdown, frontmatter included: the folder's
	edit of the file. Typing is held over it and saved a second
	after the last keystroke, even after this view goes away, valid or not,
	so a file that is not a valid capture is
	repaired here. A changed saved source causes a whole-file conflict;
	the typing stays pinned until the person explicitly resolves it.

	What keeps the file from reading as a capture follows the current edit,
	including unsaved text. Open as capture changes views without saving.
	Opened to edit one thought, it selects that thought's lines. The parent
	keys this view by the capture.
-->
<script lang="ts">
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { unsavedText } from '@epicenter/svelte/write-failure';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { untrack } from 'svelte';
	import { resultMutationOptions } from 'wellcrafted/query';
	import { type Captures, capturePath, describeFailure, readCaptureBody } from '$lib/captures.svelte.js';
	import { copyText } from '$lib/download.js';
	import { confirmDelete } from '$lib/item-actions.js';

	let {
		captures,
		stem,
	}: {
		captures: Captures;
		/** The capture shown. The parent keys this view by it. */
		stem: string;
	} = $props();

	// The view is keyed by the capture, so its path never changes for this view.
	const path = untrack(() => capturePath(stem));
	/** The folder's edit of the file: its exact text as stored, and what is typed over it. */
	const fileEdit = untrack(() => createFileEdit(captures.folder.tables.captures.edit(stem)));
	const status = $derived(fileEdit.readStatus);
	const unreadable = $derived(status.known === 'not-text');
	const pending = $derived(fileEdit.pending);
	const unsaved = $derived(pending === undefined ? undefined : unsavedText(pending));
	const text = $derived(fileEdit.text);
	const finishDraft = createMutation(() => resultMutationOptions({
		mutationKey: ['captures', 'finish-draft', stem],
		mutationFn: () => captures.finishDraft(stem),
	}));
	const draft = $derived(fileEdit.markdown?.issues === null && fileEdit.markdown.fields.draft === true);
	const locked = $derived(fileEdit.locked || finishDraft.isPending);
	let refusal = $state<string>();

	function finish() {
		if (locked || !draft || !fileEdit.markdown?.body?.trim()) return;
		finishDraft.mutate();
	}
	/** The thought's lines to select as the text appears, when opened to edit one. */
	const selection = untrack(() => captures.opened?.focus);
	function selectThought(node: HTMLTextAreaElement) {
		if (typeof selection !== 'object') return;
		node.focus();
		node.setSelectionRange(selection.start, selection.end);
	}
	/** Poll this edit's file while shown, including changes made outside this page. */
	createQuery(() => captures.readQuery(fileEdit));

	/** Why the current edit is not a capture yet: each with its line when it has one. */
	const issues = $derived.by((): readonly { line?: number; message: string }[] => {
		const row = fileEdit.markdown;
		if (row === undefined || unreadable) return [];
		if (row.issues !== null) return row.issues;
		const { error: refusal } = readCaptureBody(row);
		return refusal === null ? [] : [{ message: refusal.message }];
	});

	async function copy(value: string | undefined, what: string) {
		if (value !== undefined && (await copyText(value))) toast.success(`${what} copied`);
		else toast.error('Could not copy. Select the text and copy it.');
	}

	function confirmDiscard() {
		confirmationDialog.open({
			title: 'Discard your edit?',
			description: `Copy anything you need first. ${path} keeps what was last saved.`,
			confirm: { text: 'Discard edit', variant: 'destructive' },
			onConfirm: () => void fileEdit.discard(),
		});
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<Button variant="outline" size="sm" onclick={() => captures.leave()}>Back to timeline</Button>
		<h1 class="mr-auto min-w-0 truncate font-mono text-sm">{path}</h1>
		{#if text !== undefined}
			{#if draft}
				<Button size="sm" disabled={locked || !fileEdit.markdown?.body?.trim()} onclick={finish}>
					{finishDraft.isPending ? 'Adding…' : 'Add capture'}
				</Button>
			{:else}
				<Button size="sm" variant="outline" disabled={issues.length > 0} onclick={() => captures.open(stem, 'capture')}>Open as capture</Button>
			{/if}
			<Button size="sm" variant="ghost" onclick={() => copy(text, 'File text')}>Copy file text</Button>
			<Button size="sm" variant="ghost" disabled={locked} onclick={() => confirmDelete(captures, stem)}>{draft ? 'Discard draft…' : 'Delete…'}</Button>
		{/if}
	</div>

	{#if draft}
		<p class="text-sm text-muted-foreground">This saved draft is its full Markdown file. Add capture finishes its writing and adds the Thoughts section. Ctrl or ⌘ + Enter adds it.</p>
	{/if}
	{#if finishDraft.error}
		<Alert.Root variant="destructive" role="alert">
			<Alert.Title>The capture was not added</Alert.Title>
			<Alert.Description>{describeFailure(finishDraft.error)}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if pending?.error && !pending.saving}
		<Alert.Root variant="destructive" aria-label="Not saved">
			<Alert.Title>Your edit is not saved</Alert.Title>
			<Alert.Description>{describeFailure(pending.error)} Your edit is still here.</Alert.Description>
			<div class="mt-2 flex flex-wrap gap-2 text-foreground">
				<Button size="sm" variant="outline" onclick={() => void fileEdit.save()}>Save again</Button>
				<Button size="sm" variant="outline" onclick={() => copy(unsaved, 'Your text')}>Copy your text</Button>
				<Button size="sm" variant="ghost" onclick={confirmDiscard}>Discard edit</Button>
			</div>
		</Alert.Root>
	{/if}

	{#if text !== undefined}
		{@const shown = text}
		<p class="text-xs text-muted-foreground" role="status" aria-label="Save status">
			{#if fileEdit.pending}
				{#if fileEdit.pending.error && !fileEdit.pending.saving}
					Not saved
				{:else}
					Saving…
				{/if}
			{:else}
				Saved to {path}
			{/if}
		</p>

		{#if issues.length > 0}
			<div class="rounded-md border bg-destructive/5 px-4 py-2 text-sm" role="status" aria-label="Needs repair">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					{pending === undefined
						? 'This text does not read as a capture yet. Fix it here; it saves when you pause.'
						: 'This text does not read as a capture yet. It is checked as you type.'}
				</p>
				<ul class="space-y-0.5 text-muted-foreground">
					{#each issues as issue, index (index)}
						<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
					{/each}
				</ul>
			</div>
		{/if}

		<Textarea
			aria-label="Contents of {path}"
			class="min-h-96 font-mono text-xs"
			spellcheck={false}
			readonly={locked}
			aria-invalid={refusal !== undefined}
			bind:value={
				() => shown.replace(/\r\n?/g, '\n'),
				(typing) => {
					// The first change starts from the source shown; later ones keep theirs.
					if (locked) return;
					const { error } = fileEdit.replaceText(withFileNewlines(typing.toWellFormed(), shown));
					refusal = error?.message;
					if (error === null) finishDraft.reset();
				}
			}
			onkeydown={(event) => {
				if (!draft || !(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
				event.preventDefault();
				finish();
			}}
			{@attach selectThought}
		/>
		{#if refusal}<p role="alert" class="text-sm text-destructive">{refusal} Your previous text is kept.</p>{/if}
	{:else if unreadable}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This file cannot be edited here</Empty.Title>
				<Empty.Description>It is not text. Nothing in it was changed.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if status.known === 'missing'}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This capture is no longer here</Empty.Title>
				<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if status.error}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This capture could not be opened</Empty.Title>
				<Empty.Description>{status.error.message}</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button variant="outline" size="sm" onclick={() => void fileEdit.read()}>Try again</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<Loading label="Opening…" />
	{/if}
</div>
