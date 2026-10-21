<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { getFolder } from './context.js';
	import { Button } from '@epicenter/ui/button';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { unsavedText } from '@epicenter/svelte/write-failure';

	/**
	 * One file of the window's folder, edited as the exact text it holds.
	 * What is typed is held by the folder (`folder.files.edit(path)`), not by
	 * this editor: it saves a second after the last keystroke, when the box
	 * loses focus, and when the editor goes away, and choosing the file again
	 * shows it. The folder merges each save, by line, with whatever else was
	 * saved meanwhile, so lines another window or agent changed stay. A
	 * reread never replaces what is typed. A failed save keeps the typing and
	 * offers Try again, or Discard. A file that is not text, or whose line
	 * endings a text box would rewrite, is shown and not changed. The view
	 * keys this editor by the file.
	 */
	let { path: shownPath }: { path: string } = $props();

	const { folder, queries } = getFolder();

	// The view keys this editor by its file; while it replaces one, the prop
	// may already read the next file, so a save sent as it goes uses this.
	// svelte-ignore state_referenced_locally
	const path = shownPath;

	/** The folder's edit of the file: its exact text as stored, and what is typed over it. */
	const fileEdit = createFileEdit(folder.files.edit(path));
	// Poll for outside programs' changes; the edit owns the document and read status.
	createQuery(() => queries.read(fileEdit));
	const status = $derived(fileEdit.readStatus);
	const pending = $derived(fileEdit.pending);
	/** Whether the file is shown as it is stored, with no typing over it. */
	const untyped = $derived(pending === undefined);
	/** Unapplied structured input stays copyable until source repair is safe. */
	const fieldsLocked = $derived(
		pending?.kind === 'document' &&
		Object.keys(pending.fields).length > 0 &&
		fileEdit.markdown?.issues?.some((issue) => issue.kind !== 'schema') === true,
	);
	/** Text held for a file that no longer reads as text is available for copying. */
	const sourceLocked = $derived(pending?.kind !== 'text' && status.known !== 'file');
	/** The last text this editor showed, kept to copy once the file is deleted elsewhere. */
	let lastShown: string | undefined;
	/**
	 * Exact presented text, held input included, or the last text shown once
	 * the file is gone. The edit refuses to decode a file that is not text.
	 */
	const text = $derived.by(() => {
		const now = fileEdit.text;
		if (now !== undefined) lastShown = now;
		return now ?? (status.known === 'missing' ? lastShown : undefined);
	});
	/** A textarea would rewrite mixed line endings or lone carriage returns. */
	const mixed = $derived.by(() => {
		if (text === undefined) return false;
		const other = text.replaceAll('\r\n', '');
		return other.includes('\r') || (text.includes('\r\n') && other.includes('\n'));
	});
	let refusal = $state<string>();
	/** The text box's text: one line feed per line, as a text box holds it. */
	const boxText = $derived(text?.replaceAll('\r\n', '\n') ?? '');

	// The input outlives the editor; send what is typed now.
	onDestroy(() => void fileEdit.save());
</script>

<section class="flex min-h-0 flex-1 flex-col" aria-label={path}>
	<header class="flex items-center gap-3 border-b px-4 py-2">
		<h3 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h3>
		<span class="text-xs text-muted-foreground" role="status">
			{#if fileEdit.locked}
				Another operation is using this file.
			{:else if pending !== undefined && pending.error === undefined}
				Saving…
			{:else if pending?.error !== undefined}
				Not saved
			{:else if text !== undefined && !sourceLocked && !mixed}
				Saved when you pause or leave the box.
			{/if}
		</span>
	</header>
	{#if pending?.error !== undefined && !pending.saving}
		<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0">
			<Alert.Description>
				<p>Your edit was not saved: {pending.error.message}</p>
				{#if pending.kind === 'document'}<p>{fieldsLocked ? 'Copy the structured changes or discard them before repairing the source.' : 'Your structured changes remain available to copy.'}</p><pre class="whitespace-pre-wrap font-mono text-xs">{unsavedText(pending)}</pre>{/if}
				<div class="mt-1 flex gap-2">
					<Button size="xs" variant="outline" onclick={() => void fileEdit.save()}>Try again</Button>
					<Button size="xs" variant="ghost" onclick={() => fileEdit.discard()}>
						Discard edit
					</Button>
				</div>
			</Alert.Description>
		</Alert.Root>
	{/if}
	{#if refusal}<p role="alert" class="border-b px-4 py-2 text-sm text-destructive">{refusal}</p>{/if}
	{#if status.error}
		<div class="p-4">
			<Alert.Root variant="destructive">
				<Alert.Description>
					This file does not read: {status.error.message}
					<Button size="xs" variant="outline" onclick={() => void fileEdit.read()}>Try reading again</Button>
				</Alert.Description>
			</Alert.Root>
		</div>
	{/if}
	<!-- A failed reread does not remove the text already presented. -->
	{#if untyped && text === undefined && status.known === 'nothing'}
		{#if status.reading}<p class="p-4 text-sm text-muted-foreground">Reading…</p>{/if}
	{:else if untyped && text === undefined && status.known === 'missing'}
		<p class="p-4 text-sm text-muted-foreground">This file no longer exists.</p>
	{:else if untyped && status.known === 'not-text'}
		<p class="p-4 text-sm text-muted-foreground">
			This file is not text, so it is not shown here. It is left as it is.
		</p>
	{:else if mixed}
		<div class="flex min-h-0 flex-1 flex-col gap-2 p-4">
			<p class="text-sm text-muted-foreground">
				This file mixes line endings, which editing here would change, so it is shown as it is and not edited.
			</p>
			<pre class="min-h-0 flex-1 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">{text}</pre>
		</div>
	{:else if text !== undefined}
		{#if status.known === 'missing'}
			<p class="border-b px-4 py-2 text-sm text-muted-foreground">
				{#if pending?.kind === 'text'}This file was deleted elsewhere. Saving puts your text back in it.
				{:else}This file was deleted elsewhere. The last text is available to copy.{/if}
			</p>
		{/if}
		<Textarea
			class="min-h-0 w-full flex-1 resize-none bg-transparent p-4 font-mono text-sm outline-none"
			aria-label="Text of {path}"
			spellcheck="false"
			readonly={fieldsLocked || sourceLocked || fileEdit.locked}
			bind:value={() => boxText, (value) => {
				const { error } = fileEdit.replaceText(withFileNewlines(value, text ?? ''));
				refusal = error?.message;
			}}
			onblur={() => void fileEdit.save()}
		/>
	{/if}
</section>
