<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { parseRow } from '@epicenter/folder';
	import { basename, dirname, withFileNewlines } from '@epicenter/folder/file-browser';
	import { wellFormed } from '@epicenter/folder';
	import { toast } from '@epicenter/ui/sonner';
	import { audioMimeTypeOf } from '$lib/audio-format.js';
	import { TRANSCRIPTIONS, whisperingDefinition } from '$lib/definition.js';
	import type { Draft, Library } from '$lib/library.svelte.js';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete, copyPath, lf, openItem } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import { Textarea } from '@epicenter/ui/textarea';
	import SaveBar from '@epicenter/svelte/save-bar';

	let {
		library,
		path,
		draft,
		onBack,
	}: {
		library: Library;
		path: string;
		/** The open draft at `path`: a transcript's body, a file's text, or what it is. */
		draft: Draft;
		/** Shown on narrow windows, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	/** A transcript that reads: its body is edited here, its fields kept. */
	const row = $derived(draft.kind === 'row' && draft.table === TRANSCRIPTIONS ? draft.session : undefined);
	const text = $derived(draft.kind === 'text' ? draft : undefined);
	/** Why a row file's text is not a row yet, read live from what is typed. */
	const issues = $derived(
		text?.table === undefined
			? undefined
			: (parseRow(whisperingDefinition.tables[text.table], text.session.draft).error ?? undefined),
	);

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
			<Button variant="ghost" size="icon-sm" aria-label="Back to recordings" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		{#if draft.kind === 'audio'}
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

	{#if draft.kind === 'loading'}
		<Loading class="flex-1" label="Opening {name}…" />
	{:else if draft.kind === 'failed'}
		<Empty.Root class="flex-1">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not open this file</Empty.Title>
			<Empty.Description>{draft.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void openItem(library, path)}>Try again</Button>
		</Empty.Root>
	{:else if row}
		<SaveBar
			save={row.state}
			review={row.review}
			onRetry={() => row.retry()}
			onReloadTheirs={() => library.reloadTheirs(row)}
			gone={!library.canKeepMine(row)}
			onKeepMine={library.canKeepMine(row) ? () => library.keepMine(row) : undefined}
		/>
		<div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3 sm:px-4">
			<p class="text-xs text-muted-foreground">
				The transcript’s text, the body of its file. Its fields are kept as they are.
				<Button size="xs" variant="outline" class="ml-1" onclick={() => void show(true)}>Edit the whole file</Button>
			</p>
			<Textarea
				class="min-h-40 flex-1 resize-none font-sans"
				bind:value={
					() => lf(row?.draft.body ?? ''),
					(value) =>
						row?.edit((draft) => {
							draft.body = withFileNewlines(wellFormed(value), draft.body);
						})
				}
				disabled={row.locked}
				aria-label="Contents of {name}"
			/>
		</div>
	{:else if text}
		<SaveBar
			save={text.session.state}
			review={text.session.review}
			onRetry={() => text.session.retry()}
			onReloadTheirs={() => library.reloadTheirs(text.session)}
			gone={!library.canKeepMine(text.session)}
			onKeepMine={library.canKeepMine(text.session) ? () => library.keepMine(text.session) : undefined}
		/>
		{#if issues}
			<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					This text does not read as a row yet. Fix it here; it saves as you type.
				</p>
				<ul class="space-y-0.5 text-muted-foreground">
					{#each issues as issue, index (index)}
						<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
					{/each}
				</ul>
			</div>
		{:else if text.table === TRANSCRIPTIONS}
			<p class="shrink-0 px-4 pt-2 text-xs text-muted-foreground">
				The whole file, as its text. It saves as typed.
				<Button size="xs" variant="outline" class="ml-1" onclick={() => void show(false)}>Edit the text only</Button>
			</p>
		{/if}
		<div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-40 flex-1 resize-none font-mono text-xs"
				bind:value={() => lf(text?.session.draft ?? ''), (value) => text?.session.input(withFileNewlines(value, text.session.draft))}
				disabled={text.session.locked}
				aria-label="Contents of {name}"
				spellcheck={false}
			/>
		</div>
	{:else if draft.kind === 'audio'}
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-4" data-testid="audio-file-view">
			<AudioPlayer source={{ kind: 'file', files: library.folder.files, path, generation: library.generation }} label="Audio in {name}" />
			<dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
				<dt class="text-muted-foreground">Type</dt>
				<dd>{details(draft.size)} · {audioMimeTypeOf(path)}</dd>
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
	{:else if draft.kind === 'binary' || draft.kind === 'tooLarge'}
		<Empty.Root class="flex-1">
			<Empty.Media><FileIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>{details(draft.size)}</Empty.Title>
			<Empty.Description>
				{draft.kind === 'binary'
					? 'This file is not text, so it is listed here but not opened for editing.'
					: 'This text file is larger than 1 MB, so it is not opened in the editor.'}
				Rename, delete, and the terminal still work on it.
			</Empty.Description>
		</Empty.Root>
	{/if}

	<FileNameBar
		prefix={directory === '' ? '' : `${directory}/`}
		{name}
		onRename={(next) => library.rename(path, next)}
		onDelete={() => void confirmDelete(library, path)}
	/>
</section>
