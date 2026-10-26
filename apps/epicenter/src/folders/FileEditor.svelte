<script lang="ts">
	import type { FolderFile, ReadError } from '@epicenter/folder';
	import { openedFile, withFileNewlines, type OpenedFile } from '@epicenter/folder/file-browser';
	import { draft, type SvelteFolder } from '@epicenter/svelte/folder';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { onDestroy } from 'svelte';
	import { fileText } from './files.js';

	let { folder, path }: { folder: SvelteFolder<Record<never, never>>; path: string } = $props();
	const file = $derived(folder.file(path));
	let fetched = $state.raw<{ from: FolderFile; opened?: OpenedFile; error?: ReadError }>();
	$effect(() => {
		const from = folder.file(path);
		if (!from || from.data !== undefined || from.readError || fetched?.from === from) return;
		void folder.read(path).then(({ data, error }) => {
			if (folder.file(path) === from)
				fetched = error ? { from, error } : { from, opened: data ? openedFile(data) : undefined };
		});
	});
	const opened = $derived.by(() => {
		if (typeof file?.data === 'string') return { kind: 'text', text: file.data } as const;
		if (file?.data instanceof Uint8Array) return openedFile(file.data);
		return fetched?.opened;
	});
	const base = $derived(opened?.kind === 'text' ? opened.text : undefined);
	const classification = $derived(base === undefined ? undefined : fileText(base));
	// The parent keys this editor by path, so its identity stays fixed until teardown.
	// svelte-ignore state_referenced_locally
	const editedPath = path;
	let lastBase = '';
	let active = true;
	$effect(() => {
		if (base !== undefined) lastBase = base;
	});
	onDestroy(() => { active = false; });
	const input = draft(
		() => base?.replaceAll('\r\n', '\n') ?? '',
		async (value) => {
			const out = withFileNewlines(value, lastBase);
			lastBase = out;
			const result = await folder.write(editedPath, out);
			const current = folder.file(editedPath);
			if (active && result.error === null && current && current.data === undefined)
				fetched = { from: current, opened: { kind: 'text', text: out } };
			return result;
		},
	);
</script>

<section class="flex min-h-0 flex-1 flex-col" aria-label={path}>
	<header class="flex items-center gap-3 border-b px-4 py-2">
		<h3 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h3>
	</header>
	{#if !file}
		<p class="p-4 text-sm text-muted-foreground">This file is no longer in the folder.</p>
	{:else}
		{#if file.readError || (fetched?.from === file && fetched.error)}
			<div class="p-4"><Alert.Root variant="destructive"><Alert.Description>
				{file.readError?.message ?? fetched?.error?.message}
				<Button size="xs" variant="outline" onclick={() => { fetched = undefined; void folder.refresh(); }}>Try again</Button>
			</Alert.Description></Alert.Root></div>
		{/if}
		{#if opened?.kind === 'binary' || opened?.kind === 'tooLarge'}
			<p class="p-4 text-sm text-muted-foreground">This file cannot be edited as text ({opened.size} bytes).</p>
		{:else if classification?.kind === 'mixed'}
			<div class="flex min-h-0 flex-1 flex-col gap-2 p-4">
				<p class="text-sm text-muted-foreground">This file mixes line endings, which editing here would change, so it is shown as it is and not edited.</p>
				<pre class="min-h-0 flex-1 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">{classification.text}</pre>
			</div>
		{:else if base !== undefined}
			<Textarea
				class="min-h-0 w-full flex-1 resize-none bg-transparent p-4 font-mono text-sm outline-none"
				aria-label="Text of {path}"
				spellcheck="false"
				bind:value={input.value}
			/>
			<UnsavedEdit draft={input} />
		{:else if fetched?.from === file && fetched.opened === undefined && !fetched.error}
			<p class="p-4 text-sm text-muted-foreground">This file is no longer in the folder.</p>
		{:else if !file.readError && !(fetched?.from === file && fetched.error)}
			<p class="p-4 text-sm text-muted-foreground">Reading…</p>
		{/if}
	{/if}
</section>
