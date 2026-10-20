<!--
	A file opened beside the recordings. A transcript that reads shows its
	body, edited as a row. Any other text file, and a row file shown as text,
	shows its exact text from its own query. An edit holds the version it
	started from and is written at once, one write at a time for this file.
-->
<script lang="ts">
	import { textRead, audioRead } from '$lib/file-reads.js';

	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { basename, dirname, withFileNewlines } from '@epicenter/folder/file-browser';
	import { toast } from '@epicenter/ui/sonner';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { audioMimeTypeOf } from '$lib/audio-format.js';
	import { TRANSCRIPTIONS } from '$lib/definition.js';
	import { type Library, rowTableOf } from '$lib/library.svelte.js';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete, copyPath, lf, openItem } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import SaveStatus from './SaveStatus.svelte';
	import { Textarea } from '@epicenter/ui/textarea';

	let {
		library,
		path,
		onBack,
	}: {
		library: Library;
		/** The file shown. The parent keys this view by it. */
		path: string;
		/** Shown on narrow windows, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	// The parent keys this view by the file; what is typed is sent to that one.
	// svelte-ignore state_referenced_locally
	const own = path;
	// The library's timers outlive the view; send what is typed now instead.
	onDestroy(() => {
		void library.saveBody(own);
		void library.saveText(own);
	});
	const table = $derived(rowTableOf(path));
	const audio = $derived(table === undefined && audioMimeTypeOf(path) !== undefined);
	const asText = $derived(!audio && library.showsText(path));
	/**
	 * This view's transcript row and its text: each shows the view's own read
	 * with own saves and what is typed over it, and typing names what it last
	 * showed.
	 */
	// svelte-ignore state_referenced_locally
	const transcriptView = library.rowView(TRANSCRIPTIONS, own);
	const opened = createQuery(() => ({ ...library.local.queries.file(path, textRead), enabled: asText }));
	// svelte-ignore state_referenced_locally
	const textView = library.textView(own, () =>
		opened.data?.kind === 'text' ? opened.data.bytes : undefined,
	);
	/** A transcript that reads: its body is edited here, its fields kept. */
	const transcript = $derived(
		table === TRANSCRIPTIONS && !asText ? transcriptView.row : undefined,
	);
	/** The file's text as typed while an edit is unsaved, else as read with own saves. */
	const text = $derived(
		textView.pending !== undefined || opened.data?.kind === 'text' ? textView.text : undefined,
	);
	/** Why a row file, as last saved, is not a row yet. Typing saves after a pause, and this follows. */
	const issues = $derived(
		table === undefined || text === undefined ? undefined : (library.rowSource(table, path)?.issues ?? undefined),
	);
	const locked = $derived(library.locked(path));
	const pending = $derived(library.heldAt(path));

	async function show(source: boolean) {
		const problem = source ? await library.editSource(path) : await library.useForm(path);
		if (problem)
			toast.error(source ? 'The text was not opened for editing' : 'The text was not opened alone', {
				description: problem,
			});
	}

	const name = $derived(basename(path));
	const directory = $derived(dirname(path));
	/** The recording whose row names this file as its audio, if one does. */
	const owner = $derived(library.recordingNaming(path));

	/** A file shown as details: its extension names the type, then its size when it is known. */
	function details(size?: number) {
		const dot = name.lastIndexOf('.');
		const kind = dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : 'File';
		if (size === undefined) return kind;
		if (size < 1024) return `${kind} · ${size} ${size === 1 ? 'byte' : 'bytes'}`;
		if (size < 1024 * 1024) return `${kind} · ${(size / 1024).toFixed(1)} KB`;
		return `${kind} · ${(size / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="File">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to recordings" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		{#if audio}
			<AudioLinesIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{:else}
			<FileIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-sm font-medium">{name}</h2>
			<p class="truncate font-mono text-xs text-muted-foreground">{path}</p>
		</div>
		<Button variant="ghost" size="icon-sm" tooltip="Copy path" aria-label="Copy path" onclick={() => void copyPath(path)}>
			<CopyIcon />
		</Button>
	</div>

	{#if transcript === undefined && pending !== undefined}
		<SaveStatus {library} {path} class="shrink-0 border-b px-4 py-1" />
		<div class="space-y-2 p-4" role="status">
			<p>The saved file no longer reads. Your unsaved changes are kept below.</p>
			<Textarea readonly aria-label="Unsaved file changes" value={JSON.stringify({fields: pending.fields, body: pending.body}, null, 2)} class="min-h-40 font-mono text-xs" />
		</div>
	{:else if audio}
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-4" data-testid="audio-file-view">
			<AudioPlayer source={{ kind: 'file', query: library.local.queries.file(path, audioRead) }} label="Audio in {name}" />
			<dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
				<dt class="text-muted-foreground">Type</dt>
				<dd>{details()} · {audioMimeTypeOf(path)}</dd>
				<dt class="text-muted-foreground">Recording</dt>
				<dd>
					{#if owner}
						<Button variant="link" class="h-auto p-0" onclick={() => void openItem(library, owner.path)}>
							{owner.row.fields.title || owner.path}
						</Button>
					{:else}
						No recording row names this file.
					{/if}
				</dd>
			</dl>
		</div>
	{:else if transcript}
		<SaveStatus {library} {path} class="shrink-0 border-b px-4 py-1" />
		<div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3 sm:px-4">
			<p class="text-xs text-muted-foreground">
				The transcript’s text, the body of its file. Its fields are kept as they are.
				<Button size="xs" variant="outline" class="ml-1" onclick={() => void show(true)}>Edit the whole file</Button>
			</p>
			<Textarea
				class="min-h-40 flex-1 resize-none font-sans"
				bind:value={
					() => transcript?.body ?? '',
					(value) => library.editBody(transcriptView, value)
				}
				onblur={() => void library.saveBody(path)}
				disabled={locked}
				aria-label="Contents of {name}"
			/>
		</div>
	{:else if !asText}
		<Empty.Root class="flex-1">
			<Empty.Title>{name} is no longer in the folder</Empty.Title>
			<Empty.Description>It was renamed or deleted, here or by another program.</Empty.Description>
		</Empty.Root>
	{:else if text !== undefined}
		<SaveStatus {library} {path} class="shrink-0 border-b px-4 py-1" />
		{#if issues}
			<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					This file does not read as a row yet. Fix it here; it saves when you pause.
				</p>
				<ul class="space-y-0.5 text-muted-foreground">
					{#each issues as issue, index (index)}
						<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
					{/each}
				</ul>
			</div>
		{:else if table === TRANSCRIPTIONS}
			<p class="shrink-0 px-4 pt-2 text-xs text-muted-foreground">
				The whole file, as its text. It saves as typed.
				<Button size="xs" variant="outline" class="ml-1" onclick={() => void show(false)}>Edit the text only</Button>
			</p>
		{/if}
		<div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-40 flex-1 resize-none font-mono text-xs"
				bind:value={() => lf(text ?? ''), (value) => library.editText(textView, withFileNewlines(value, text ?? ''))}
				onblur={() => void library.saveText(path)}
				disabled={locked}
				aria-label="Contents of {name}"
				spellcheck={false}
			/>
		</div>
	{:else if opened.data?.kind === 'binary' || opened.data?.kind === 'tooLarge'}
		<Empty.Root class="flex-1">
			<Empty.Media><FileIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>{details(opened.data.size)}</Empty.Title>
			<Empty.Description>
				{opened.data.kind === 'binary'
					? 'This file is not text, so it is listed here but not opened for editing.'
					: 'This text file is larger than 1 MB, so it is not opened in the editor.'}
				Rename and delete still work on it.
			</Empty.Description>
		</Empty.Root>
	{:else if opened.isError}
		<Empty.Root class="flex-1">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not open this file</Empty.Title>
			<Empty.Description>{opened.error.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void opened.refetch()}>Try again</Button>
		</Empty.Root>
	{:else}
		<Loading class="flex-1" label="Opening {name}…" />
	{/if}

	<FileNameBar
		local={library.local}
		prefix={directory === '' ? '' : `${directory}/`}
		{name}
		onRename={(next) => library.rename(path, next)}
		onDelete={() => void confirmDelete(library, path)}
	/>
</section>
