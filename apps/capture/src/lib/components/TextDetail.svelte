<!--
	One capture file as its exact Markdown, frontmatter included: the row's
	source, from the one rows query. Typing is held over it and saved a second
	after the last keystroke, when the person leaves the text, and when this
	view goes away, valid or not, so a file that is not a valid capture is
	repaired here. Each save merges with whatever was saved meanwhile.

	What keeps the file from reading as a capture is read from the file as
	saved, so it follows the text a moment after typing pauses. Open as
	capture saves the text first, and opens the capture view only once the
	saved file reads as one. The parent keys this view by the capture.
-->
<script lang="ts">
	import { captureBody } from '@epicenter/capture';
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy, untrack } from 'svelte';
	import { type Captures, capturePath, describeFailure } from '$lib/captures.svelte.js';
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
	const entry = createQuery(() => captures.rowsQuery((rows) => rows.find((found) => found.id === stem)));
	/** The file's text draft: what is typed and not saved yet. */
	const draft = untrack(() => captures.texts.text(path));
	const unreadable = $derived(entry.data?.issues?.some((issue) => issue.kind === 'not-text') ?? false);
	/** The file's source as saved, when it is text. */
	const source = $derived(entry.data === undefined || unreadable ? undefined : entry.data.text);
	const typed = $derived(draft.typed);
	const text = $derived(typed ?? source);
	const locked = $derived(captures.isLocked(stem));
	// The draft saves after a pause, and outlives the view; send it now.
	onDestroy(() => void draft.save());

	/** Why the saved file is not a capture yet: each with its line when it has one. */
	const issues = $derived.by((): readonly { line?: number; message: string }[] => {
		const row = entry.data;
		if (row === undefined || unreadable) return [];
		if (row.issues !== null) return row.issues;
		const { error: refusal } = captureBody.decode(row.body);
		return refusal === null ? [] : [{ message: refusal.message }];
	});

	/** `typed` with the line endings of the file it replaces: a text box reads `\r\n` as `\n`. */
	const withFileNewlines = (typed: string, file: string) =>
		file.includes('\r\n') ? typed.replace(/\r?\n/g, '\r\n') : typed;

	async function copy(value: string | undefined, what: string) {
		if (value !== undefined && (await copyText(value))) toast.success(`${what} copied`);
		else toast.error('Could not copy. Select the text and copy it.');
	}

	function confirmDiscard() {
		confirmationDialog.open({
			title: 'Discard your edit?',
			description: `Copy anything you need first. ${path} keeps what was last saved.`,
			confirm: { text: 'Discard edit', variant: 'destructive' },
			onConfirm: () => void draft.discard(),
		});
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<Button variant="outline" size="sm" onclick={() => captures.leave()}>Back to timeline</Button>
		<h1 class="mr-auto min-w-0 truncate font-mono text-sm">{path}</h1>
		{#if text !== undefined}
			<Button
				size="sm"
				variant="outline"
				disabled={typed === undefined && issues.length > 0}
				onclick={() => captures.open(stem, 'capture')}>Open as capture</Button
			>
			<Button size="sm" variant="ghost" onclick={() => copy(text, 'File text')}>Copy file text</Button>
			<Button size="sm" variant="ghost" disabled={locked} onclick={() => confirmDelete(captures, stem)}>Delete…</Button>
		{/if}
	</div>

	{#if text !== undefined}
		<p class="text-xs text-muted-foreground" role="status" aria-label="Save status">
			{typed === undefined ? `Saved to ${path}` : draft.error && !draft.saving ? 'Not saved' : 'Saving…'}
		</p>

		{#if draft.error && !draft.saving}
			<Alert.Root variant="destructive" aria-label="Not saved">
				<Alert.Title>Your edit is not saved</Alert.Title>
				<Alert.Description>{describeFailure(draft.error)} Your edit is still here.</Alert.Description>
				<div class="mt-2 flex flex-wrap gap-2 text-foreground">
					<Button size="sm" variant="outline" onclick={() => void draft.save()}>Save again</Button>
					<Button size="sm" variant="outline" onclick={() => copy(typed, 'Your text')}>Copy your text</Button>
					<Button size="sm" variant="ghost" onclick={confirmDiscard}>Discard edit</Button>
				</div>
			</Alert.Root>
		{/if}

		{#if issues.length > 0}
			<div class="rounded-md border bg-destructive/5 px-4 py-2 text-sm" role="status" aria-label="Needs repair">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					{typed === undefined
						? 'This text does not read as a capture yet. Fix it here; it saves when you pause.'
						: 'As last saved, this text did not read as a capture. It is checked again when your typing is saved.'}
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
			bind:value={
				() => (text ?? '').replace(/\r\n?/g, '\n'),
				(typing) => {
					// The first change starts from the source shown; later ones keep theirs.
					if (text !== undefined) draft.change(source ?? text, withFileNewlines(typing.toWellFormed(), text));
				}
			}
			onblur={() => void draft.save()}
		/>
	{:else if unreadable}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This file cannot be edited here</Empty.Title>
				<Empty.Description>It is not text. Nothing in it was changed.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if entry.isSuccess}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This capture is no longer here</Empty.Title>
				<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if entry.isError}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This capture could not be opened</Empty.Title>
				<Empty.Description>{entry.error.message}</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button variant="outline" size="sm" onclick={() => void entry.refetch()}>Try again</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<Loading label="Opening…" />
	{/if}
</div>
