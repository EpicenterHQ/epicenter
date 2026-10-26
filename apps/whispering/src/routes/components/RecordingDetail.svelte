<!--
	One recording: its audio, transcripts, notes, and source. Each input is a
	draft over the row the folder shows: what was typed shows until its save
	answers, then the row again. Source edits the file's exact text and checks
	it as it is typed, so a row that needs repair shows what is still wrong.
-->
<script lang="ts">
	import { readRow } from '@epicenter/folder';
	import { edit, fileEdit } from '@epicenter/svelte/folder';
	import RowIssues from '@epicenter/svelte/row-issues';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import { toast } from '@epicenter/ui/sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import XIcon from '@lucide/svelte/icons/x';
	import { getFolder } from '$lib/folder.js';
	import { RECORDINGS, rowIdOf, whisperingTables } from '$lib/definition.js';
	import { getWhispering, type RecordingEntry } from '$lib/whispering.svelte.js';
	import AudioAbsent from './AudioAbsent.svelte';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete } from './file-actions.js';
	import { Input } from '@epicenter/ui/input';
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
	const folder = getFolder();

	/**
	 * What is worked on comes first: the audio, then the transcript beside it,
	 * then notes. What describes the files (when, how long, where, which ID) is
	 * kept, one press away, under File details.
	 */
	// The parent keys this view by the file; keep its original path.
	// svelte-ignore state_referenced_locally
	const own = path;
	const id = rowIdOf(RECORDINGS, own) ?? own;
	const stored = $derived(folder.tables.recordings.row(id));
	const file = $derived(folder.file(own));

	const title = edit(
		() => (stored?.issues === null ? stored.fields.title : ''),
		(title) => folder.tables.recordings.update(id, { fields: { title } }),
	);
	const notes = edit(
		() => (stored?.issues === null ? stored.body : ''),
		(body) => folder.tables.recordings.update(id, { body }),
	);
	const source = fileEdit(folder, own);

	const asText = $derived(whispering.showsText(own));
	/** The file's text, when the folder holds it as text. */
	const text = $derived(typeof file?.data === 'string' ? file.data : undefined);
	/** Why the text in Source does not read as a recording, as it is typed. */
	const issues = $derived(
		asText && text !== undefined
			? (readRow(source.value, whisperingTables.recordings).issues ?? undefined)
			: undefined,
	);
	/** The recording as the folder shows it, while its fields are what is edited. */
	const row = $derived(!asText && stored?.issues === null ? stored : undefined);
	const shownTitle = $derived(row ? title.value : (entry?.row.fields.title ?? ''));

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

	/** The view changes now; queued edits keep their order. */
	function show(toSource: boolean) {
		const problem = toSource ? whispering.editSource(own) : whispering.useForm(own, source.value);
		if (problem) toast.error(toSource ? 'The text was not opened for editing' : 'The fields were not opened', { description: problem });
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
				bind:value={title.value}
				placeholder="Title"
				aria-label="Recording title"
			/>
		{:else}
			<h2 class="min-w-0 flex-1 truncate text-base font-medium" data-testid="recording-title-text">{shownTitle || id}</h2>
		{/if}
		{#if onClose}
			<Button variant="ghost" size="icon-sm" tooltip="Close details" aria-label="Close details" onclick={onClose} data-testid="close-detail">
				<XIcon />
			</Button>
		{/if}
	</div>
	{#if title.error}
		<div class="px-4 pt-2"><UnsavedEdit edit={title} /></div>
	{/if}

	{#if issues}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				This file does not read as a recording yet. Fix it here; it saves as you type.
			</p>
			<RowIssues {issues} />
		</div>
	{/if}

	{#if file?.readError}
		<div class="flex flex-col items-start gap-2 border-b px-4 py-2 text-sm" role="alert" data-testid="row-unopened">
			<p class="text-destructive">This file could not be read: {file.readError.message}</p>
			<Button size="sm" variant="outline" onclick={() => folder.refresh()}>Try again</Button>
		</div>
	{/if}

	{#if file === undefined}
		<p class="flex-1 px-4 py-4 text-sm text-muted-foreground" role="status">This file is no longer in the folder.</p>
	{:else if text === undefined}
		{#if file.data !== undefined}
			<p class="flex-1 px-4 py-4 text-sm text-muted-foreground" role="status" data-testid="row-unopened">This file is not UTF-8 text, so it is not opened here.</p>
		{/if}
	{:else}
	<Tabs.Root bind:value={() => (asText ? 'source' : 'details'), (value) => void show(value === 'source')} class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
		<Tabs.List>
			<Tabs.Trigger value="details" disabled={issues !== undefined}>Details</Tabs.Trigger>
			<Tabs.Trigger value="source">Source</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="details" class="min-h-0 flex-1 overflow-y-auto">
			{#if row}
			<div class="flex flex-col gap-4 py-1">
				{#if absent}
					<AudioAbsent />
				{:else if audio?.kind === 'ambiguous'}
					<p class="text-sm text-destructive" role="alert">More than one audio file matches this recording: {audio.paths.join(', ')}. Keep one matching file.</p>
				{:else if audioPath}
					<AudioPlayer
						path={audioPath}
						label="Audio of {shownTitle || id}"
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
						bind:value={notes.value}
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
			<p class="text-xs text-muted-foreground">
				The file’s exact text. It saves as you type, readable or not.
			</p>
			<Textarea
				class="h-full min-h-40 flex-1 resize-none font-mono text-xs"
				bind:value={source.value}
				{@attach () => { whispering.editSource(own); }}
				aria-label="Markdown source"
				spellcheck={false}
			/>
		</Tabs.Content>
	</Tabs.Root>
	{/if}
	<UnsavedEdit edit={notes} />
	<UnsavedEdit edit={source} />

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(whispering, path)}>
			Delete recording
		</Button>
	</div>
</section>
