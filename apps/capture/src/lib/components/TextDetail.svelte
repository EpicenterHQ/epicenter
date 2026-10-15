<!--
	One capture file as its exact Markdown, frontmatter included. Typing is
	held over the file's text and written a second after the last keystroke,
	when the person leaves the text, and when this view goes away, valid or
	not, so a file that is not a valid capture is repaired here. What keeps it from
	reading as a capture is read live from the text; once nothing does, Open
	as capture shows its text and thoughts. The parent keys this view by the
	capture.
-->
<script lang="ts">
	import { captureBody, captureDefinition, fromTextarea, toTextarea } from '@epicenter/capture';
	import { parseRow, rowPath, wellFormed } from '@epicenter/folder';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createQuery } from '@tanstack/svelte-query';
	import { useDebounce } from 'runed';
	import { onDestroy, untrack } from 'svelte';
	import type { Captures } from '$lib/captures.svelte.js';
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
	const path = untrack(() => rowPath(captures.folder.tables.captures.name, stem));
	const file = createQuery(() => captures.folder$.files.text.queryOptions(path));
	/** The text typed and not written yet. */
	const typed = $derived(captures.typedText(path));
	const text = $derived(
		file.data?.kind === 'text' ? (typed ?? file.data.file.text) : undefined,
	);
	const locked = $derived(captures.fenced || captures.isRemoving(path));
	const saveLater = useDebounce(() => captures.saveText(path), 1000);
	// runed's timer outlives the view; save now instead.
	onDestroy(() => void saveLater.runScheduledNow());

	/** Why the text is not a capture yet: each with its line when it has one. */
	const issues = $derived.by((): readonly { line?: number; message: string }[] => {
		if (text === undefined) return [];
		const { data: row, error } = parseRow(captureDefinition.tables.captures, text);
		if (error !== null) return error;
		const { error: refusal } = captureBody.decode(row.body);
		return refusal === null ? [] : [{ message: refusal.message }];
	});

	async function copy() {
		if (text !== undefined && (await copyText(text))) toast.success('File text copied');
		else toast.error('Could not copy. Select the text and copy it.');
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
				disabled={issues.length > 0}
				onclick={() => captures.open(stem, 'capture')}>Open as capture</Button
			>
			<Button size="sm" variant="ghost" onclick={copy}>Copy file text</Button>
			<Button size="sm" variant="ghost" disabled={locked} onclick={() => void confirmDelete(captures, stem)}>Delete…</Button>
		{/if}
	</div>

	{#if text !== undefined}
		<p class="text-xs text-muted-foreground" role="status" aria-label="Save status">
			{typed === undefined ? `Saved to ${path}` : 'Saving…'}
		</p>

		{#if issues.length > 0}
			<div class="rounded-md border bg-destructive/5 px-4 py-2 text-sm" role="status" aria-label="Needs repair">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					This text does not read as a capture yet. Fix it here; it saves when you pause.
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
				() => toTextarea(text ?? ''),
				(typed) => {
					if (text === undefined) return;
					const taken = captures.editText(
						path,
						fromTextarea(text, wellFormed(typed), text.includes('\r\n') ? '\r\n' : '\n'),
					);
					if (taken) void saveLater();
				}
			}
			onblur={() => void saveLater.runScheduledNow()}
		/>
	{:else if file.data !== undefined}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This file cannot be edited here</Empty.Title>
				<Empty.Description>
					{file.data.kind === 'binary' ? 'It is not UTF-8 text.' : 'It is too large to edit here.'} Nothing in it was changed.
				</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if file.isError}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>
					{file.error.name === 'NotFound' ? 'This capture is no longer in the folder' : 'This capture could not be opened'}
				</Empty.Title>
				<Empty.Description>{file.error.message}</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button variant="outline" size="sm" onclick={() => void file.refetch()}>Try again</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<Loading label="Opening…" />
	{/if}
</div>
