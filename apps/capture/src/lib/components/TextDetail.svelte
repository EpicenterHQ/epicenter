<!--
	One capture's file as Markdown, front matter included: the file's own
	text, whether it reads as a capture or not, through the note's editor
	(`folder.captures.edit`, its whole `text`). Typing saves it, in house
	style where its front matter parses: text that does not read is written,
	and the capture shows to repair until it does (ADR-0775). Whether it reads is checked as the person types; one
	whose Thoughts read opens as a capture once what was typed has landed.
-->
<script lang="ts">
	import { capture, capturePath } from '../model/index.js';
	import { describeIssues, readNoteText } from '@epicenter/definition/contract';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { onDestroy, untrack } from 'svelte';
	import { folder } from '$lib/app.js';
	import { type Captures, readCaptureBody } from '$lib/captures.svelte.js';
	import { copyText } from '$lib/download.js';
	import { confirmDelete } from '$lib/item-actions.js';

	let { captures, id }: { captures: Captures; id: string } = $props();

	// The editor is keyed by the capture, so it does not change for its life.
	const args = untrack(() => ({ id }));
	const path = capturePath(args.id);
	const collection = capture.collections.captures;
	let active = true;
	onDestroy(() => {
		active = false;
	});

	/** The note's whole text: what was typed until it lands, else the file as shown. */
	const edit = folder.captures.edit(args);
	const note = $derived(folder.captures.get(args));
	const broken = $derived(folder.captures.invalid().find((file) => file.id === args.id));
	/** Whether there is text to edit: a capture, a file that does not read but is text, or typing not yet landed. */
	const present = $derived(note !== undefined || (broken !== undefined && broken.text !== null) || edit.typed() !== null);
	const value = $derived(edit.text);
	/** How the text reads: its front matter, then its Thoughts. */
	const typed = $derived(readNoteText(collection, value));
	const thoughts = $derived(typed.error === null ? readCaptureBody(typed.data) : undefined);
	const reads = $derived(typed.error === null && thoughts?.error === null);
	let opening = $state(false);
	const selection = untrack(() => captures.opened?.focus);

	function selectThought(node: HTMLTextAreaElement) {
		if (typeof selection !== 'object') return;
		node.focus();
		node.setSelectionRange(selection.start, selection.end);
	}

	/** Open the capture as one once what was typed has landed, so it opens as saved. */
	async function openAsCapture() {
		opening = true;
		await edit.landed();
		opening = false;
		if (active) captures.open(args.id, 'capture');
	}

	async function copy(text: string, what: string) {
		if (await copyText(text)) toast.success(`${what} copied`);
		else toast.error('Could not copy. Select the text and copy it.');
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<Button variant="outline" size="sm" onclick={() => captures.leave()}>Back to timeline</Button>
		<h1 class="mr-auto min-w-0 truncate font-mono text-sm">{path}</h1>
		{#if present}
			<Button size="sm" variant="outline" disabled={!reads || opening} onclick={() => void openAsCapture()}>Open as capture</Button>
			<Button size="sm" variant="ghost" onclick={() => void copy(value, 'File text')}>Copy file text</Button>
			{#if note !== undefined || broken !== undefined}
				<Button size="sm" variant="ghost" onclick={() => void confirmDelete(captures, args.id)}>Delete…</Button>
			{/if}
		{/if}
	</div>

	{#if present}
		{#if !reads}
			<div class="rounded-md border bg-destructive/5 px-4 py-2 text-sm" role="status" aria-label="Needs repair">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					This text does not read as a capture yet. It is saved and checked as you type.
				</p>
				<div class="space-y-0.5 text-muted-foreground">
					{#if typed.error !== null}<p>{describeIssues(typed.error.issues)}</p>{/if}
					{#if thoughts?.error}<p>{thoughts.error.message}</p>{/if}
				</div>
			</div>
		{/if}
		<Textarea
			aria-label="Contents of {path}"
			class="min-h-96 font-mono text-xs"
			spellcheck={false}
			bind:value={() => value, (text) => (edit.text = text)}
			{@attach selectThought}
		/>
	{:else if broken !== undefined}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This file cannot be edited here</Empty.Title>
				<Empty.Description>It is not text. Nothing in it was changed.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This capture is no longer here</Empty.Title>
				<Empty.Description>
					{#if folder.reveal !== null}
						It was deleted, here or by another program using Capture's folder.
					{:else}
						It was deleted, here, in another tab, or on another device.
					{/if}
				</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{/if}
</div>
