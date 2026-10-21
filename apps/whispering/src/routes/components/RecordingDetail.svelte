<!--
	One recording: its audio, transcripts, notes, and source. The folder's
	row edit holds title and notes together, saves after a pause, and merges
	with changes saved elsewhere. Input and autosave outlive this view.
	Saving an edit to a recording deleted elsewhere restores its Markdown file.
-->
<script lang="ts">
	import { unsavedText } from '@epicenter/svelte/write-failure';
	import { getFolder } from '$lib/folder.js';
	import { textRead } from '$lib/file-reads.js';

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
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { createQuery } from '@tanstack/svelte-query';
	import { RECORDINGS, rowIdOf } from '$lib/definition.js';
	import { getWhispering, type RecordingEntry } from '$lib/whispering.svelte.js';
	import AudioAbsent from './AudioAbsent.svelte';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete, lf } from './file-actions.js';
	import { Input } from '@epicenter/ui/input';
	import SaveStatus from './SaveStatus.svelte';
	import TranscriptCard from './TranscriptCard.svelte';

	let {
		path,
		entry,
		onBack,
		onClose,
	}: {
		/** The recording's file. The parent keys this view by it. */
		path: string;
		/** The listed row, or undefined when the file does not read. */
		entry: RecordingEntry | undefined;
		/** Shown on narrow windows, where the table and the details take turns. */
		onBack?: () => void;
		/** Shown on wide windows, where the details are a pane beside the table. */
		onClose?: () => void;
	} = $props();
	const whispering = getWhispering();

	/**
	 * What is worked on comes first: the audio, then the transcript beside it,
	 * then notes. What describes the files (when, how long, where, which ID) is
	 * kept, one press away, under File details.
	 */
	const asText = $derived(whispering.showsText(path));
	// The parent keys this view by the file; keep its original path.
	// svelte-ignore state_referenced_locally
	const own = path;
	/**
	 * One file edit supplies fields, body, whole text and diagnostics.
	 */
	// svelte-ignore state_referenced_locally
	const fileEdit = whispering.edit(RECORDINGS, own);
	const context = getFolder();
	/** What the file is while it shows as text; its reads keep the text edit current. */
	const opened = createQuery(() => ({ ...context.queries.file(path, textRead), enabled: asText }));
	/** The recording as shown, while its fields are what is edited and it reads as one. */
	const row = $derived.by(() => {
		if (asText) return undefined;
		const shown = fileEdit.markdown;
		return shown?.issues === null ? shown : undefined;
	});
	/** The file's text as typed while an edit is unsaved, else as stored. */
	const text = $derived(
		asText && (fileEdit.pending !== undefined || opened.data?.kind === 'text') ? fileEdit.text : undefined,
	);
	/** Why the current source does not read as a recording, including unsaved input. */
	const issues = $derived(asText ? (fileEdit.markdown?.issues ?? undefined) : undefined);
	const id = $derived(rowIdOf(RECORDINGS, path) ?? path);
	const title = $derived(row?.fields.title ?? entry?.row.fields.title ?? '');
	const pending = $derived(fileEdit.pending);

	const results = $derived(whispering.resultsFor(id));
	const run = $derived(whispering.transcriptionRun(id));
	/** Playback requires one unambiguous audio file. */
	const audio = $derived(entry ? whispering.audioOf(entry) : undefined);
	const audioPath = $derived(audio?.kind === 'here' ? audio.path : undefined);
	/** Whether the audio the row names is missing from this device's folder. */
	const absent = $derived(audio?.kind === 'absent');

	function when(value: string) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
	}

	function show(source: boolean) {
		const problem = source ? whispering.editSource(path) : whispering.useForm(path);
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
			{@const shown = row}
			<Input
				class="flex-1 text-base font-medium"
				bind:value={() => shown.fields.title, (value) => fileEdit.change({ fields: { title: value } })}
				disabled={fileEdit.locked}
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

	<SaveStatus {path} saved="Saved to {path}" class="shrink-0 border-b px-4 py-1" />

	{#if issues}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				This file does not read as a recording yet. Fix it here; it saves when you pause.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each issues as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if (asText ? text === undefined : row === undefined) && pending !== undefined}
		<div class="space-y-2 p-4" role="status">
			<p>The saved file no longer reads. Your unsaved changes are kept below.</p>
			<Textarea readonly aria-label="Unsaved recording changes" value={unsavedText(pending)} class="min-h-40 font-mono text-xs" />
		</div>
	{:else if asText && text === undefined && opened.isError}
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
				{@const shown = row}
			<div class="flex flex-col gap-4 py-1">
				{#if absent}
					<AudioAbsent />
				{:else if audio?.kind === 'ambiguous'}
					<p class="text-sm text-destructive" role="alert">More than one audio file matches this recording: {audio.paths.join(', ')}. Keep one matching file.</p>
				{:else if audioPath}
					<AudioPlayer
						path={audioPath}
						label="Audio of {title || id}"
					/>
				{:else}
					<p class="text-sm text-muted-foreground" data-testid="no-audio">
						Checking this recording’s audio beside its Markdown file.
					</p>
				{/if}

				<div class="flex flex-col gap-2">
					<div class="flex items-center gap-2">
						<h3 class="text-sm font-medium">Transcription</h3>
						<Button
							class="ml-auto"
							size="sm"
							disabled={entry === undefined || audioPath === undefined || whispering.capturePhase(audioPath) !== undefined || run?.kind === 'running'}
							onclick={() => entry && void whispering.transcribe(entry)}
							data-testid="transcribe"
						>
							{#if run?.kind === 'running'}<Spinner class="size-3.5" />{/if}
							{results.length > 0 ? 'Transcribe again' : 'Transcribe'}
						</Button>
					</div>
					{#if run?.kind === 'failed'}
						<p class="text-sm text-destructive" role="alert" data-testid="transcription-error">
							{run.message}
							<Button size="xs" variant="outline" class="ml-2" onclick={() => whispering.dismissRun(id)}>Dismiss</Button>
						</p>
					{/if}
					{#each results as result (result.path)}
						<TranscriptCard {result} audioAbsent={absent} />
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
							() => shown.body,
							(value) => fileEdit.change({ body: value })
						}
						disabled={fileEdit.locked}
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
						<dd>
							{row.fields.durationMs === undefined
								? 'Written when the recording stops'
								: `${(row.fields.durationMs / 1000).toFixed(1)} s`}
						</dd>
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
							{#if whispering.connections?.transcription}
								{whispering.connections.transcription.model} at {whispering.connections.transcription.baseUrl}
							{:else}
								Not set up
							{/if}
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
			{#if text !== undefined}
				{@const shown = text}
				<p class="text-xs text-muted-foreground">
					The file’s exact text. It saves when you pause, readable or not.
				</p>
				<Textarea
					class="h-full min-h-40 flex-1 resize-none font-mono text-xs"
					bind:value={() => lf(shown), (value) => fileEdit.replaceText(withFileNewlines(value, shown))}
					{@attach () => { whispering.editSource(path); }}
					disabled={fileEdit.locked}
					aria-label="Markdown source"
					spellcheck={false}
				/>
			{/if}
		</Tabs.Content>
	</Tabs.Root>
	{/if}

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(whispering, path)}>
			Delete recording
		</Button>
	</div>
</section>
