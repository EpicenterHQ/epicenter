<!--
	One file. A Markdown file opens in the source editor, its exact text as
	the repository holds it, saved as the person types; any other file
	shows its bytes as media or a download. Rename is a delete and a write
	in one transaction, once the editor has saved; Delete asks first.
-->
<script lang="ts">
	import { mediaType, type Editor, type FileEntry } from '@epicenter/repository';
	import type { Repository } from '@epicenter/repository';
	import { attachment } from '@epicenter/svelte/repository';
	import SourceEditor from '@epicenter/svelte/repository/source-editor';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { onDestroy } from 'svelte';
	import { manifest } from './manifest.js';
	import { nameOf, newPathProblem } from './tree.js';

	let {
		repo,
		path: shownPath,
		files,
		onRenamed,
		onDeleted,
	}: {
		repo: Repository<typeof manifest.collections.definitions>;
		/** Fixed: the parent keys this view by its path. */
		path: string;
		/** Every file, as last listed, so a rename does not land on one. */
		files: readonly FileEntry[] | undefined;
		onRenamed: (to: string) => void;
		onDeleted: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	const path = shownPath;
	const name = nameOf(path);
	const markdown = path.toLowerCase().endsWith('.md');
	const media = mediaType(path);
	// svelte-ignore state_referenced_locally
	const bytes = attachment(repo, () => (markdown ? null : path));
	const entry = $derived(files?.find((file) => file.path === path));

	/** The file's text as this device holds it, read again after every change: null for none, undefined until read. */
	let text = $state.raw<string | null>();
	$effect(() => {
		repo.revision();
		let current = true;
		void repo.files.read(path).then(({ data }) => {
			if (current && data !== undefined) text = data === null ? null : data.text;
		});
		return () => {
			current = false;
		};
	});

	let editor = $state.raw<Editor>();
	let unopened = $state<string>();
	let destroyed = false;
	function openEditor() {
		unopened = undefined;
		void repo.files.openEditor(path).then((opened) => {
			if (opened.error !== null) {
				if (opened.error.name !== 'NotFound') unopened = opened.error.message;
				return;
			}
			if (destroyed) void opened.data.close();
			else editor = opened.data;
		});
	}
	if (markdown) openEditor();
	$effect(() => {
		if (markdown && editor === undefined && unopened !== undefined && repo.status().status === 'open') openEditor();
	});
	onDestroy(() => {
		destroyed = true;
		void editor?.close();
	});

	let renaming = $state<string>();
	let failure = $state<string>();
	async function rename(event: SubmitEvent) {
		event.preventDefault();
		const to = (renaming ?? '').trim();
		if (to === path) {
			renaming = undefined;
			return;
		}
		failure = newPathProblem(files ?? [], to);
		if (failure !== undefined) return;
		if (to.toLowerCase().endsWith('.md') !== markdown) {
			failure = markdown ? 'A note needs a .md path.' : 'A file of bytes cannot become a .md note by renaming it.';
			return;
		}
		// Everything typed is saved first, so the rename carries it.
		const closed = await editor?.close();
		editor = undefined;
		if (closed !== undefined && closed.error !== null) {
			failure = `Not renamed: ${closed.error.message}`;
			openEditor();
			return;
		}
		const read = await repo.files.read(path);
		if (read.error !== null || read.data === null) {
			failure = read.error?.message ?? 'This file is no longer here.';
			return;
		}
		const { text: current } = read.data;
		const moved = await repo.commit((batch) => {
			batch.files.write(to, current);
			batch.files.delete(path);
		});
		if (moved.error !== null) {
			failure = `Not renamed: ${moved.error.message}`;
			if (markdown) openEditor();
			return;
		}
		onRenamed(to);
	}

	function remove() {
		confirmationDialog.open({
			title: `Delete ${name}?`,
			description: `This deletes ${path}, on this device and, when it syncs, everywhere.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const deleted = await repo.files.delete(path);
				if (deleted.error !== null) failure = deleted.error.message;
				else onDeleted();
			},
		});
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="File">
	<div class="flex flex-wrap items-center gap-2 border-b px-4 py-2">
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-sm font-medium">{name}</h2>
			<p class="truncate font-mono text-xs text-muted-foreground" data-testid="file-path" title="Path to link from a note">{path}</p>
			{#if entry?.state.status === 'held'}<p class="text-xs text-muted-foreground">Held: {entry.state.reason}</p>
			{:else if entry?.state.status === 'sending'}<p class="text-xs text-muted-foreground">Not sent{entry.state.reason === undefined ? '' : `: ${entry.state.reason}`}</p>{/if}
		</div>
		{#if text !== null && text !== undefined}
			<Button size="sm" variant="outline" onclick={() => (renaming = path)}>Rename</Button>
			<Button size="sm" variant="ghost-destructive" onclick={remove}>Delete</Button>
		{/if}
	</div>

	{#if renaming !== undefined}
		<form class="flex flex-wrap items-center gap-2 border-b px-4 py-2" aria-label="Rename" onsubmit={rename}>
			<label class="flex min-w-0 flex-1 items-center gap-2 text-sm">
				<span class="shrink-0">New path</span>
				<Input bind:value={renaming} class="min-w-0 flex-1 font-mono text-xs" />
			</label>
			<Button type="submit" size="sm">Save</Button>
			<Button size="sm" variant="ghost" onclick={() => (renaming = undefined)}>Cancel</Button>
		</form>
	{/if}
	{#if failure !== undefined}
		<p class="px-4 py-2 text-sm text-destructive" role="alert">{failure}</p>
	{/if}

	{#if text === null}
		<Empty.Root class="flex-1">
			<Empty.Title>No file is at {path}</Empty.Title>
			<Empty.Description>It was deleted, renamed, or never made. The folder still lists what is here.</Empty.Description>
		</Empty.Root>
	{:else if markdown && editor !== undefined}
		<SourceEditor {editor} check={(source) => manifest.collections.check(source)} state={entry?.state} label="Text of {name}" class="flex-1" />
	{:else if markdown && unopened !== undefined}
		<p class="flex flex-wrap items-center gap-2 px-4 py-3 text-sm text-destructive" role="alert">
			{unopened}
			<Button size="sm" variant="outline" onclick={openEditor}>Try again</Button>
		</p>
	{:else if !markdown && bytes.current.status === 'fetching'}
		<p class="px-4 py-3 text-sm text-muted-foreground">Loading file…</p>
	{:else if !markdown && bytes.current.status === 'unavailable'}
		<p class="flex items-center gap-2 px-4 py-3 text-sm" role="alert">{bytes.current.reason}<Button size="sm" variant="outline" onclick={bytes.current.retry}>Retry</Button></p>
	{:else if !markdown && bytes.current.status === 'missing'}
		<p class="px-4 py-3 text-sm">This file's bytes are not here or on the server</p>
	{:else if !markdown && bytes.current.status === 'here'}
		<div class="min-h-0 flex-1 overflow-auto p-4">
			{#if media.startsWith('image/')}
				<img src={bytes.current.url} alt={name} class="max-h-full max-w-full object-contain" />
			{:else if media.startsWith('audio/')}
				<audio src={bytes.current.url} controls aria-label={name}></audio>
			{:else if media.startsWith('video/')}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video src={bytes.current.url} controls aria-label={name} class="max-h-full max-w-full"></video>
			{:else}
				<a href={bytes.current.url} download={name}>Download {name}</a>
			{/if}
		</div>
	{/if}
</section>
