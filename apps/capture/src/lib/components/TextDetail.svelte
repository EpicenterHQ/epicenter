<!--
	One capture's file as Markdown, front matter included: the text of a
	capture that reads (in house style), or the file's own text when it does
	not, to repair. What is typed is this view's draft until Save, which
	replaces the whole note (`replace`) and is refused, with why, when the
	front matter does not parse or fit. Whether it reads is checked as the
	person types. A saved capture whose Thoughts read opens as a capture.
-->
<script lang="ts">
	import { capture, capturePath } from '@epicenter/capture';
	import { type ClientError, readNoteText, type Version } from '@epicenter/definition/contract';
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { onDestroy, untrack } from 'svelte';
	import { type Captures, captureText, describeIssues, readCaptureBody } from '$lib/captures.svelte.js';
	import { copyText } from '$lib/download.js';
	import { confirmDelete } from '$lib/item-actions.js';

	let { captures, id }: { captures: Captures; id: string } = $props();

	// The view is keyed by the capture, so neither changes for this view.
	const args = untrack(() => ({ id }));
	const list = untrack(() => captures.list);
	const path = capturePath(args.id);
	const collection = capture.collections.captures;
	let active = true;
	onDestroy(() => {
		active = false;
	});

	const note = $derived(list.get(args));
	const broken = $derived(list.invalid.find((file) => file.id === args.id));
	/** The file's text as shown: a capture's in house style, or a broken file's own. */
	const source = $derived.by(() => {
		if (note !== undefined) {
			const written = captureText(note);
			return written.error === null ? written.data : undefined;
		}
		return broken?.text ?? undefined;
	});
	/**
	 * What was typed and not saved, and the version of the file it began
	 * from, which Save replaces over: another writer's change since is a
	 * `Conflict`, never overwritten unseen. Null follows the file.
	 */
	let draft = $state<{ text: string; over: Version | undefined } | null>(null);
	const value = $derived(draft?.text ?? source ?? '');
	const changed = $derived(draft !== null && draft.text !== source);
	/** How the text reads: its front matter as `replace` reads it, then its Thoughts. */
	const typed = $derived(readNoteText(collection, value));
	const thoughts = $derived(typed.error === null ? readCaptureBody(typed.data) : undefined);
	const reads = $derived(typed.error === null && thoughts?.error === null);
	let saving = $state(false);
	let refusal = $state<ClientError | null>(null);
	const selection = untrack(() => captures.opened?.focus);

	function selectThought(node: HTMLTextAreaElement) {
		if (typeof selection !== 'object') return;
		node.focus();
		node.setSelectionRange(selection.start, selection.end);
	}

	function input(text: string) {
		draft = { text, over: draft === null ? (note?.version ?? broken?.version) : draft.over };
	}

	async function save() {
		if (saving || draft === null) return;
		saving = true;
		const { text, over } = draft;
		const replaced = await list.replace(args, text, { over });
		saving = false;
		if (!active) return;
		if (replaced.error !== null) {
			refusal = replaced.error;
			// Saving again is a choice made knowing: it replaces what is there now.
			if (draft !== null && replaced.error.name === 'Conflict') draft = { ...draft, over: undefined };
			return;
		}
		refusal = null;
		draft = null;
		if (readCaptureBody(replaced.data).error === null) captures.open(args.id, 'capture');
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
		{#if source !== undefined || draft !== null}
			{#if changed}
				<Button size="sm" disabled={saving} onclick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
			{:else}
				<Button size="sm" variant="outline" disabled={!reads} onclick={() => captures.open(args.id, 'capture')}>Open as capture</Button>
			{/if}
			<Button size="sm" variant="ghost" onclick={() => void copy(value, 'File text')}>Copy file text</Button>
			{#if source !== undefined}
				<Button size="sm" variant="ghost" onclick={() => void confirmDelete(captures, args.id)}>Delete…</Button>
			{/if}
		{/if}
	</div>

	{#if refusal !== null}
		<Alert.Root variant="destructive" aria-label="Not saved">
			<Alert.Title>Not saved</Alert.Title>
			<Alert.Description>
				{#if refusal.name === 'Invalid'}
					<p>{describeIssues(refusal.issues)}</p>
				{:else if refusal.name === 'NotFound' || (refusal.name === 'Conflict' && refusal.current === null)}
					<p>This file was deleted elsewhere. Your text is kept to copy.</p>
				{:else if refusal.name === 'Conflict'}
					<p>This file changed elsewhere since you began editing. Your text is kept: Save again replaces the file with it, or Use the saved text.</p>
				{:else}
					<p>{refusal.message}</p>
				{/if}
			</Alert.Description>
			{#if refusal.name === 'Conflict' && refusal.current !== null}
				<div class="mt-2 text-foreground">
					<Button size="sm" variant="outline" onclick={() => { draft = null; refusal = null; }}>Use the saved text</Button>
				</div>
			{/if}
		</Alert.Root>
	{/if}

	{#if source !== undefined || draft !== null}
		{#if !reads}
			<div class="rounded-md border bg-destructive/5 px-4 py-2 text-sm" role="status" aria-label="Needs repair">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					This text does not read as a capture yet. It is checked as you type.
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
			bind:value={() => value, input}
			{@attach selectThought}
		/>
		{#if changed}
			<p class="text-xs text-muted-foreground">Not saved yet. Leaving this capture discards it.</p>
		{/if}
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
				<Empty.Description>It was deleted, here, in another tab, or on another device.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{/if}
</div>
