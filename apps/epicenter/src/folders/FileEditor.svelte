<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { getFolder } from './context.js';
	import { Button } from '@epicenter/ui/button';
	import { createQuery } from '@tanstack/svelte-query';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { withFileNewlines } from '@epicenter/folder/file-browser';

	/**
	 * One file of the window's folder, edited as the exact text it holds.
	 * What is typed is held by the folder (`folder.files.edit(path)`), not by
	 * this editor: it saves a second after the last keystroke, even after
	 * the editor goes away, and choosing the file again
	 * shows it. A reread never replaces what is typed; a changed stored file
	 * causes a conflict, and both sources remain available for resolution.
	 * A failed save keeps the typing and offers recovery. A file that is not text, or whose line
	 * endings a text box would rewrite, is shown and not changed. The view
	 * keys this editor by the file.
	 */
	let { path: shownPath }: { path: string } = $props();

	const { folder, queries } = getFolder();

	// The view keys this editor by its file; keep its original path.
	// svelte-ignore state_referenced_locally
	const path = shownPath;

	/** The folder's edit of the file: its exact text as stored, and what is typed over it. */
	const fileEdit = createFileEdit(folder.files.edit(path));
	// Poll for outside programs' changes; the edit owns the document and read status.
	createQuery(() => queries.read(fileEdit));
	const buffer = $derived(fileEdit.buffer);
	const unsaved = $derived(buffer.status === 'ready' ? buffer.unsaved : undefined);
	const missing = $derived(buffer.error?.name === 'SourceUnavailable' && buffer.error.reason === 'missing');
	const notText = $derived(buffer.error?.name === 'SourceUnavailable' && buffer.error.reason === 'not-text');
	/** A held source remains editable after an outside deletion or replacement. */
	const sourceLocked = $derived(buffer.status !== 'ready');
	const conflict = $derived(unsaved?.status === 'conflict' ? unsaved.error : undefined);
	function conflictText(bytes: Uint8Array): string | undefined {
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		} catch {
			return undefined;
		}
	}
	const conflictCurrent = $derived(conflict?.current === null
		? '(deleted)'
		: typeof conflict?.current === 'string'
			? conflict.current
			: conflict?.current === undefined
				? undefined
				: conflictText(conflict.current));
	/** The last text this editor showed, kept to copy once the file is deleted elsewhere. */
	let lastShown: string | undefined;
	/**
	 * Exact presented text, held input included, or the last text shown once
	 * the file is gone. The edit refuses to decode a file that is not text.
	 */
	const text = $derived.by(() => {
		const now = fileEdit.text;
		if (now !== undefined) lastShown = now;
		return now ?? (missing ? lastShown : undefined);
	});
	/** A textarea would rewrite mixed line endings or lone carriage returns. */
	const mixed = $derived.by(() => {
		if (text === undefined) return false;
		const other = text.replaceAll('\r\n', '');
		return other.includes('\r') || (text.includes('\r\n') && other.includes('\n'));
	});
	/** The text box's text: one line feed per line, as a text box holds it. */
	const boxText = $derived(text?.replaceAll('\r\n', '\n') ?? '');
</script>

<section class="flex min-h-0 flex-1 flex-col" aria-label={path}>
	<header class="flex items-center gap-3 border-b px-4 py-2">
		<h3 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h3>
		<span class="text-xs text-muted-foreground" role="status">
			{#if fileEdit.locked}
				Another operation is using this file.
			{:else if unsaved?.status === 'dirty' || unsaved?.status === 'saving'}
				Saving…
			{:else if unsaved?.error !== undefined}
				Not saved
			{:else if text !== undefined && !sourceLocked && !mixed}
				Saved when you pause or leave the box.
			{/if}
		</span>
	</header>
	{#if unsaved}
		{#if unsaved.status === 'failed' || unsaved.status === 'conflict'}
			<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0">
				<Alert.Description>
					<p>Your edit was not saved: {unsaved.error.message}</p>
					{#if conflict !== undefined}
						<p>The saved file changed. Your source remains in the editor below. You can keep the saved file, replace it with your source, or edit your source before replacing it.</p>
						<details><summary>Compare sources</summary><p>Saved source</p><pre class="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">{conflictCurrent ?? '(binary file)'}</pre><p>Your source</p><pre class="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">{fileEdit.text}</pre></details>
					{/if}
					<div class="mt-1 flex gap-2">
						{#if conflict !== undefined}
							<Button size="xs" variant="outline" onclick={() => void fileEdit.resolveConflict('current')}>Use saved file</Button>
							<Button size="xs" variant="outline" onclick={() => void fileEdit.resolveConflict('draft')}>Replace saved file</Button>
						{:else}
							<Button size="xs" variant="outline" onclick={() => void fileEdit.save()}>Try again</Button>
						{/if}
						<Button size="xs" variant="ghost" onclick={() => fileEdit.discard()}>
							Discard edit
						</Button>
					</div>
				</Alert.Description>
			</Alert.Root>
		{/if}
	{/if}
	{#if buffer.error && buffer.error.name !== 'SourceUnavailable'}
		<div class="p-4">
			<Alert.Root variant="destructive">
				<Alert.Description>
					This file could not be updated: {buffer.error.message}
					<Button size="xs" variant="outline" onclick={() => void fileEdit.read()}>Try reading again</Button>
				</Alert.Description>
			</Alert.Root>
		</div>
	{/if}
	<!-- A failed reread does not remove the text already presented. -->
	{#if buffer.status === 'loading' || buffer.status === 'unread'}
		<p class="p-4 text-sm text-muted-foreground">Reading…</p>
	{:else if buffer.status === 'unavailable' && text === undefined && missing}
		<p class="p-4 text-sm text-muted-foreground">This file no longer exists.</p>
	{:else if buffer.status === 'unavailable' && notText}
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
		{#if missing}
			<p class="border-b px-4 py-2 text-sm text-muted-foreground">
				This file was deleted elsewhere. Your unsaved source is still available; saving will report a conflict.
			</p>
		{/if}
		<Textarea
			class="min-h-0 w-full flex-1 resize-none bg-transparent p-4 font-mono text-sm outline-none"
			aria-label="Text of {path}"
			spellcheck="false"
			readonly={sourceLocked || fileEdit.locked}
			bind:value={() => boxText, (value) => {
				if (text !== undefined) fileEdit.replaceText(withFileNewlines(value, text));
			}}
		/>
	{/if}
</section>
