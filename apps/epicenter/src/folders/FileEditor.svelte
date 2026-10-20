<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { getFolder } from './context.js';
	import { Button } from '@epicenter/ui/button';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { Textarea } from '@epicenter/ui/textarea';
	import type { FileDrafts } from './drafts.svelte';
	import { fileKey, fileText } from './files';

	/**
	 * One file of the window's folder, edited as the exact text it holds.
	 * What is typed is the folder's draft of the file (`drafts.file`), which
	 * the window holds, not this editor: it saves a second after the last
	 * keystroke, when the box loses focus, and when the editor goes away, and
	 * choosing the file again shows it. The folder merges each save, by line,
	 * with whatever else was saved meanwhile, so lines another window or
	 * agent changed stay. A reread never replaces what is typed. A failed
	 * save keeps the typing and offers Try again, or Discard. A file that is
	 * not text, or whose line endings a text box would rewrite, is shown and
	 * not changed. The view keys this editor by the file.
	 */
	let {
		drafts,
		path: shownPath,
	}: {
		/** The typing held in the folder, which outlives this editor. */
		drafts: FileDrafts;
		/** The file this editor edits. */
		path: string;
	} = $props();

	const context = getFolder();

	// The view keys this editor by its file; while it replaces one, the prop
	// may already read the next file, so a save sent as it goes uses this.
	// svelte-ignore state_referenced_locally
	const path = shownPath;
	const files = context.folder.files;
	// svelte-ignore state_referenced_locally
	const draft = drafts.file(path);

	const stored = createQuery(() => ({
		queryKey: fileKey(context.queries.key, path),
		queryFn: async () => {
			const read = await files.read(path);
			if (read.error !== null) throw read.error;
			if (read.data === undefined) return null;
			return new Uint8Array(await read.data.content.arrayBuffer());
		},
	}));
	const shown = $derived(
		stored.data === undefined || stored.data === null ? undefined : fileText(stored.data),
	);

	/** The file's content, which the draft starts from at its first keystroke. */
	const base = $derived(
		shown?.kind === 'text' && stored.data != null
			? { content: stored.data, crlf: shown.crlf }
			: undefined,
	);
	/** Whether the file is shown as it is stored, with no typing over it. */
	const untyped = $derived(!draft.held);

	// The draft outlives the editor; send what is typed now.
	onDestroy(() => void draft.save());
</script>

<section class="flex min-h-0 flex-1 flex-col" aria-label={path}>
	<header class="flex items-center gap-3 border-b px-4 py-2">
		<h3 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h3>
		<span class="text-xs text-muted-foreground" role="status">
			{#if draft.exclusivePending}
				Saving view settings; source editing resumes when it finishes.
			{:else if draft.saving}
				Saving…
			{:else if draft.error !== undefined}
				Not saved
			{:else if shown?.kind === 'text'}
				Saved when you pause or leave the box.
			{/if}
		</span>
	</header>
	{#if draft.error !== undefined && !draft.saving}
		<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0">
			<Alert.Description>
				<p>Your edit was not saved: {draft.error.message}</p>
				{#if draft.sourceLocked}<p>Copy the field changes or discard them before repairing the source.</p><pre class="whitespace-pre-wrap font-mono text-xs">{draft.fieldText}</pre>{/if}
				<div class="mt-1 flex gap-2">
					<Button size="xs" variant="outline" onclick={() => void draft.retry()}>Try again</Button>
					<Button size="xs" variant="ghost" onclick={() => draft.discard()}>
						Discard edit
					</Button>
				</div>
			</Alert.Description>
		</Alert.Root>
	{/if}
	<!-- Typing held is always shown, whatever the file reads as now. -->
	{#if untyped && stored.error}
		<div class="p-4">
			<Alert.Root variant="destructive">
				<Alert.Description>This file does not read: {stored.error.message}</Alert.Description>
			</Alert.Root>
		</div>
	{:else if untyped && stored.isPending}
		<p class="p-4 text-sm text-muted-foreground">Reading…</p>
	{:else if untyped && stored.data === null}
		<p class="p-4 text-sm text-muted-foreground">This file no longer exists.</p>
	{:else if untyped && shown?.kind === 'binary'}
		<p class="p-4 text-sm text-muted-foreground">
			This file is not text ({shown.size} bytes), so it is not shown here. It is left as it is.
		</p>
	{:else if untyped && shown?.kind === 'mixed'}
		<div class="flex min-h-0 flex-1 flex-col gap-2 p-4">
			<p class="text-sm text-muted-foreground">
				This file mixes line endings, which editing here would change, so it is shown as it is and not edited.
			</p>
			<pre class="min-h-0 flex-1 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">{shown.text}</pre>
		</div>
	{:else}
		{#if stored.data === null}
			<p class="border-b px-4 py-2 text-sm text-muted-foreground">
				This file was deleted elsewhere. Saving puts your text back in it.
			</p>
		{/if}
		<Textarea
			class="min-h-0 w-full flex-1 resize-none bg-transparent p-4 font-mono text-sm outline-none"
			aria-label="Text of {path}"
			spellcheck="false"
			readonly={draft.sourceLocked || draft.exclusivePending}
			bind:value={() => draft.shown(base) ?? (shown?.kind === 'text' ? shown.text : ''), (value) => draft.type(String(value), base)}
			onblur={() => void draft.save()}
		/>
	{/if}
</section>
