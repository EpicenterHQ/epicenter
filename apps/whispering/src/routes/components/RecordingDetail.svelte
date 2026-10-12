<!--
	One recording: its audio, transcripts, notes, and source. The fields come
	from the recordings listing in the cache, so this view never disagrees
	with the table. Each edit goes into that cache and is written at once.
	A recording deleted elsewhere is never written again: its write fails,
	and the view closes.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import XIcon from '@lucide/svelte/icons/x';
	import { parseRow, type Row, rowStemOf } from '@epicenter/folder';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { wellFormed } from '@epicenter/folder';
	import { createQuery } from '@tanstack/svelte-query';
	import { audioPathIn, RECORDINGS, type RecordingFields, whisperingDefinition } from '$lib/definition.js';
	import type { Library, RecordingEntry } from '$lib/library.svelte.js';
	import { committedState } from '$lib/status.js';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete, lf } from './file-actions.js';
	import { Input } from '@epicenter/ui/input';
	import TranscriptCard from './TranscriptCard.svelte';

	let {
		library,
		path,
		entry,
		onBack,
		onClose,
	}: {
		library: Library;
		/** The recording's file. The parent keys this view by it. */
		path: string;
		/** The listed row, or undefined when the file does not read. */
		entry: RecordingEntry | undefined;
		/** Shown on narrow windows, where the table and the details take turns. */
		onBack?: () => void;
		/** Shown on wide windows, where the details are a pane beside the table. */
		onClose?: () => void;
	} = $props();

	/**
	 * What is worked on comes first: the audio, then the transcript beside it,
	 * then notes. What describes the files (when, how long, where, which ID) is
	 * kept, one press away, under File details.
	 */
	const asText = $derived(library.showsText(path));
	/** The recording as the cache holds it, while its fields are what is edited. */
	const row = $derived(asText ? undefined : library.rowAt(RECORDINGS, path)?.row);
	const opened = createQuery(() => ({ ...library.textQuery(path), enabled: asText }));
	const text = $derived(asText && opened.data?.kind === 'text' ? opened.data.file : undefined);
	/** Why the text on screen is not a recording yet, read live from what is typed. */
	const issues = $derived(text && (parseRow(whisperingDefinition.tables.recordings, text.text).error ?? undefined));
	const id = $derived(rowStemOf(RECORDINGS, path) ?? path);
	const title = $derived(row?.fields.title ?? entry?.row.fields.title ?? '');
	/** Edits wait while the app decides whether to close, and while this file is renamed or deleted. */
	const locked = $derived(library.locked(path));
	const saving = $derived(library.isSaving(path));

	/** Change the recording in the cache; it is written at once. */
	function set(change: (row: Row<RecordingFields>) => Row<RecordingFields>) {
		library.editRow(RECORDINGS, id, change);
	}
	const results = $derived(library.resultsFor(id));
	const run = $derived(library.transcriptionRun(id));
	/** The audio the row names. Nothing is guessed from another file's name. */
	const audioPath = $derived(entry ? audioPathIn(entry.row.fields) : undefined);
	const history = $derived(
		entry ? committedState(library.git, [entry.path, ...(audioPath ? [audioPath] : [])]) : undefined,
	);

	function when(value: string) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
	}

	async function show(source: boolean) {
		const problem = source ? await library.editSource(path) : await library.useForm(path);
		if (problem) toast.error(source ? 'The text was not opened for editing' : 'The fields were not opened', { description: problem });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Recording" data-testid="recording-detail">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to recordings" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		{#if row}
			<Input
				class="flex-1 text-base font-medium"
				bind:value={
					() => row?.fields.title ?? '',
					(value) => set((r) => ({ ...r, fields: { ...r.fields, title: wellFormed(value) } }))
				}
				disabled={locked}
				placeholder="Title"
				aria-label="Recording title"
			/>
		{:else}
			<h2 class="min-w-0 flex-1 truncate text-base font-medium" data-testid="recording-title-text">{title || id}</h2>
		{/if}
		{#if onClose}
			<Button variant="ghost" size="icon-sm" tooltip="Close details" aria-label="Close details" onclick={onClose} data-testid="close-detail">
				<XIcon />
			</Button>
		{/if}
	</div>

	<p class="shrink-0 border-b px-4 py-1 text-xs text-muted-foreground" role="status" data-testid="write-status">
		{saving ? 'Saving…' : `Saved to ${path}`}
	</p>

	{#if issues}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				This text does not read as a recording yet. Fix it here; it saves as you type.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each issues as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if asText && opened.isError}
		<div class="flex flex-1 flex-col items-start gap-2 px-4 py-4 text-sm" role="alert" data-testid="row-unopened">
			<p>This recording’s file could not be opened: {opened.error.message}</p>
			<Button size="sm" variant="outline" onclick={() => void opened.refetch()}>Try again</Button>
		</div>
	{:else if asText ? text === undefined : row === undefined}
		<Loading class="flex-1" label="Opening the recording…" />
	{:else}
	<Tabs.Root bind:value={() => (asText ? 'source' : 'details'), (value) => void show(value === 'source')} class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
		<Tabs.List>
			<Tabs.Trigger value="details" disabled={issues !== undefined}>Details</Tabs.Trigger>
			<Tabs.Trigger value="source">Source</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="details" class="min-h-0 flex-1 overflow-y-auto">
			{#if row}
			<div class="flex flex-col gap-4 py-1">
				{#if audioPath}
					<AudioPlayer
						source={{ kind: 'file', files: library.folder.files, path: audioPath, generation: library.generation }}
						label="Audio of {title || id}"
					/>
				{:else}
					<p class="text-sm text-muted-foreground" data-testid="no-audio">
						This recording’s file names no audio: it has no <code class="font-mono">audioPath</code>. Add the audio
						file’s path in Source.
					</p>
				{/if}

				<div class="flex flex-col gap-2">
					<div class="flex items-center gap-2">
						<h3 class="text-sm font-medium">Transcription</h3>
						<Button
							class="ml-auto"
							size="sm"
							disabled={entry === undefined || audioPath === undefined || run?.kind === 'running' || run?.kind === 'unsaved'}
							onclick={() => entry && void library.transcribe(entry)}
							data-testid="transcribe"
						>
							{#if run?.kind === 'running'}<Spinner class="size-3.5" />{/if}
							{results.length > 0 ? 'Transcribe again' : 'Transcribe'}
						</Button>
					</div>
					{#if run?.kind === 'failed'}
						<p class="text-sm text-destructive" role="alert" data-testid="transcription-error">
							{run.message}
							<Button size="xs" variant="outline" class="ml-2" onclick={() => library.dismissRun(id)}>Dismiss</Button>
						</p>
					{:else if run?.kind === 'unsaved'}
						<div class="rounded border border-destructive/40 p-2 text-sm" role="alert">
							<p class="text-destructive">The transcript arrived, but its file is not confirmed as saved: {run.message}</p>
							<p class="my-2 whitespace-pre-wrap">{run.text}</p>
							<p class="mb-2 text-xs text-muted-foreground">
								Saving again writes <code class="font-mono">transcriptions/{run.id}.md</code>, or finds it there from an
								earlier attempt, and does not call the endpoint again. Nothing new is transcribed until this is saved, or
								discarded in the notice under the header.
							</p>
							<Button size="xs" disabled={run.saving} onclick={() => void library.retrySaveResult(id)}>
								{#if run.saving}<Spinner class="size-3" />{/if}
								Save it again
							</Button>
						</div>
					{/if}
					{#each results as result (result.path)}
						<TranscriptCard {library} {result} />
					{:else}
						{#if run === undefined}
							<p class="text-sm text-muted-foreground">No transcription yet.</p>
						{/if}
					{/each}
				</div>

				<div class="flex flex-col gap-1.5">
					<h3 class="text-sm font-medium">Notes</h3>
					<Textarea
						class="min-h-28 resize-y font-sans"
						bind:value={
							() => lf(row?.body ?? ''),
							(value) => set((r) => ({ ...r, body: withFileNewlines(wellFormed(value), r.body) }))
						}
						disabled={locked}
						placeholder="Notes in Markdown, saved in the recording’s file"
						aria-label="Notes"
					/>
				</div>

				<Collapsible.Root>
					<Collapsible.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="sm" class="group -ml-2 text-muted-foreground" data-testid="file-details">
								<ChevronRightIcon class="transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none" />
								File details
							</Button>
						{/snippet}
					</Collapsible.Trigger>
					<Collapsible.Content class="pt-2">
					<dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
						<dt class="text-muted-foreground">Recorded</dt>
						<dd>{when(row.fields.recordedAt)}</dd>
						<dt class="text-muted-foreground">Length</dt>
						<dd>{(row.fields.durationMs / 1000).toFixed(1)} s</dd>
						<dt class="text-muted-foreground">Captured from</dt>
						<dd>
							{#if row.fields.capture === 'fixture'}
								<Badge variant="outline">Fixture audio, not a microphone take</Badge>
							{:else}
								Microphone
							{/if}
						</dd>
						<dt class="text-muted-foreground">Transcribes with</dt>
						<dd class="min-w-0 break-words">
							{#if library.connections?.transcription}
								{library.connections.transcription.model} at {library.connections.transcription.baseUrl}
							{:else}
								Not set up
							{/if}
						</dd>
						<dt class="text-muted-foreground">History</dt>
						<dd data-testid="recording-history">
							{history === 'uncommitted' ? 'Saved · not in history yet' : history === 'committed' ? 'In history' : 'Unknown'}
						</dd>
						<dt class="text-muted-foreground">ID</dt>
						<dd class="min-w-0 font-mono text-xs break-all">{id}</dd>
						<dt class="text-muted-foreground">Files</dt>
						<dd class="min-w-0 font-mono text-xs break-all">
							{path}{#if audioPath}<br />{audioPath}{/if}{#each results as result (result.path)}<br />{result.path}{/each}
						</dd>
					</dl>
					</Collapsible.Content>
				</Collapsible.Root>
			</div>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col gap-2">
			{#if text}
				<p class="text-xs text-muted-foreground">
					The file’s exact text. It saves as typed, readable or not.
				</p>
				<Textarea
					class="h-full min-h-40 flex-1 resize-none font-mono text-xs"
					bind:value={() => lf(text?.text ?? ''), (value) => library.editText(path, withFileNewlines(value, text?.text ?? ''))}
					disabled={locked}
					aria-label="Markdown source"
					spellcheck={false}
				/>
			{/if}
		</Tabs.Content>
	</Tabs.Root>
	{/if}

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(library, path)}>
			Delete recording
		</Button>
	</div>
</section>
