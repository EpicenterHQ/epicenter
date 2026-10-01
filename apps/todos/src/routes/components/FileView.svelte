<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { basename, dirname, withFileNewlines } from '$lib/files.js';
	import type { OpenFile, Todos } from '$lib/todos.svelte.js';
	import { confirmDelete, copyPath } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import SaveStatus from './SaveStatus.svelte';

	let {
		todos,
		path,
		file,
		onBack,
	}: {
		todos: Todos;
		path: string;
		file: OpenFile;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	const name = $derived(basename(path));
	const directory = $derived(dirname(path));

	/** A file shown as details: its extension names the type, then its size. */
	function details(size: number) {
		const dot = name.lastIndexOf('.');
		const kind = dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : 'File';
		if (size < 1024) return `${kind} · ${size} ${size === 1 ? 'byte' : 'bytes'}`;
		if (size < 1024 * 1024) return `${kind} · ${(size / 1024).toFixed(1)} KB`;
		return `${kind} · ${(size / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="File">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		<FileIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-sm font-medium">{name}</h2>
			<p class="truncate font-mono text-xs text-muted-foreground">{path}</p>
		</div>
		<Button variant="ghost" size="icon-sm" tooltip="Copy path" aria-label="Copy path" onclick={() => void copyPath(path)}>
			<CopyIcon />
		</Button>
	</div>

	{#if file.kind === 'loading'}
		<Loading class="flex-1" label="Opening {name}…" />
	{:else if file.kind === 'failed'}
		<Empty.Root class="flex-1">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not open this file</Empty.Title>
			<Empty.Description>{file.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void todos.open(path)}>Try again</Button>
		</Empty.Root>
	{:else if file.kind === 'text'}
		{@const editor = file.editor}
		<SaveStatus {editor} onDiscardRemoved={() => todos.discardRemoved(editor.path)} />
		<div class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-40 flex-1 resize-none font-mono text-xs"
				value={editor.buffer}
				aria-label="Contents of {name}"
				spellcheck={false}
				oninput={(event) => editor.input(withFileNewlines(event.currentTarget.value, editor.buffer))}
			/>
		</div>
	{:else}
		<Empty.Root class="flex-1">
			<Empty.Media><FileIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>{details(file.size)}</Empty.Title>
			<Empty.Description>
				{file.kind === 'binary'
					? 'This file is not text, so it is listed here but not opened for editing.'
					: 'This text file is larger than 1 MB, so it is not opened in the editor.'}
				Rename, delete, and the terminal still work on it.
			</Empty.Description>
		</Empty.Root>
	{/if}

	<FileNameBar
		prefix={directory === '' ? '' : `${directory}/`}
		{name}
		onRename={(next) => todos.rename(path, next)}
		onDelete={() => void confirmDelete(todos, path)}
	/>
</section>
