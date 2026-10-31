<!--
	One recording: its audio, transcripts, and notes. Each input is an edit
	over the note the lists show: what was typed shows until its save
	answers, then the note again. A recording whose note does not read shows
	its text, to repair.
-->
<script lang="ts">
	import { fieldEdit } from '@epicenter/svelte/client';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import { toast } from '@epicenter/ui/sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import XIcon from '@lucide/svelte/icons/x';
	import { getWhispering, type RecordingNote, type Repair } from '$lib/whispering.svelte.js';
	import AudioMissing from './AudioMissing.svelte';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete } from './file-actions.js';
	import { Input } from '@epicenter/ui/input';
	import NoteRepair from './NoteRepair.svelte';
	import RunStatus from './RunStatus.svelte';
	import TranscriptCard from './TranscriptCard.svelte';

	let {
		id,
		note,
		repair,
		onBack,
		onClose,
	}: {
		/** The recording's id. The parent keys this view by it. */
		id: string;
		/** The listed note, or undefined when it does not read or is gone. */
		note: RecordingNote | undefined;
		/** Why its note does not read, when it does not. */
		repair: Repair | undefined;
		/** Shown on narrow windows, where the table and the details take turns. */
		onBack?: () => void;
		/** Shown on wide windows, where the details are a pane beside the table. */
		onClose?: () => void;
	} = $props();
	const whispering = getWhispering();

	// The parent keys this view by the recording.
	// svelte-ignore state_referenced_locally
	const own = id;
	const title = fieldEdit(whispering.files.recordings, { id: own }, 'title');
	const notes = fieldEdit(whispering.files.recordings, { id: own }, 'body');

	const results = $derived(whispering.resultsFor(own));
	const run = $derived(whispering.transcriptionRun(own));
	const transcribing = $derived(run?.state.kind === 'running' || (run?.state.kind === 'unsaved' && run.state.message === undefined));
	const audio = $derived(whispering.audioOf(own));

	function when(value: string) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
	}

	async function transcribe() {
		const problem = await whispering.transcribe(own);
		if (problem && whispering.transcriptionRun(own) === undefined) toast.error('Nothing was sent', { description: problem });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Recording" data-testid="recording-detail" data-recording-id={own}>
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to recordings" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		{#if note}
			<Input
				class="flex-1 text-base font-medium"
				bind:value={() => title.value ?? note.title, (value) => (title.value = value)}
				placeholder="Title"
				aria-label="Recording title"
			/>
		{:else}
			<h2 class="min-w-0 flex-1 truncate text-base font-medium" data-testid="recording-title-text">{own}</h2>
		{/if}
		{#if note?.where === 'device' && whispering.signedIn}<Badge variant="outline" data-testid="not-uploaded">Not uploaded yet</Badge>{/if}
		{#if onClose}
			<Button variant="ghost" size="icon-sm" tooltip="Close details" aria-label="Close details" onclick={onClose} data-testid="close-detail">
				<XIcon />
			</Button>
		{/if}
	</div>
	{#if title.error}
		<div class="px-4 pt-2"><UnsavedEdit edit={title} /></div>
	{/if}

	{#if repair}
		<div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
			<NoteRepair {repair} />
		</div>
	{:else if note === undefined}
		<p class="flex-1 px-4 py-4 text-sm text-muted-foreground" role="status">This recording is no longer listed.</p>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3 sm:px-4">
			{#if audio.kind === 'here'}
				<AudioPlayer id={own} file={audio.file} label="Audio of {note.title || own}" />
			{:else}
				<AudioMissing {audio} />
			{/if}

			<div class="flex flex-col gap-2">
				<div class="flex items-center gap-2">
					<h3 class="text-sm font-medium">Transcription</h3>
					<Button
						class="ml-auto"
						size="sm"
						disabled={audio.kind !== 'here' || transcribing}
						onclick={() => void transcribe()}
						data-testid="transcribe"
					>
						{#if transcribing}<Spinner class="size-3.5" />{/if}
						{results.length > 0 ? 'Transcribe again' : 'Transcribe'}
					</Button>
				</div>
				{#if run && run.state.kind !== 'running'}
					<RunStatus {run} />
				{/if}
				{#each results as result (result.id)}
					<TranscriptCard {result} />
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
					bind:value={() => notes.value ?? note.body, (value) => (notes.value = value)}
					placeholder="Notes in Markdown, saved in the recording’s note"
					aria-label="Notes"
				/>
				<UnsavedEdit edit={notes} />
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
						<dd>{when(note.recordedAt)}</dd>
						<dt class="text-muted-foreground">Length</dt>
						<dd>{note.durationMs === undefined ? 'Not recorded' : `${(note.durationMs / 1000).toFixed(1)} s`}</dd>
						<dt class="text-muted-foreground">Captured from</dt>
						<dd>
							{#if note.capture === 'fixture'}
								<Badge variant="outline">Fixture audio, not a microphone take</Badge>
							{:else}
								Microphone
							{/if}
						</dd>
						<dt class="text-muted-foreground">Kept in</dt>
						<dd data-testid="kept-in">
							{note.where === 'device' ? 'This browser (not uploaded yet)' : 'Your repository'}{#if audio.kind === 'here' && audio.file.cached}; its audio is also cached in this browser{/if}
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
						<dd class="min-w-0 font-mono text-xs break-all">{own}</dd>
						<dt class="text-muted-foreground">Files</dt>
						<dd class="min-w-0 font-mono text-xs break-all">
							recordings/{own}.md{#if audio.kind === 'here'}<br />recordings/{own}.{audio.file.ext}{/if}{#each results as result (result.id)}<br />transcriptions/{result.id}.md{/each}
						</dd>
					</dl>
				</Collapsible.Content>
			</Collapsible.Root>
		</div>

		<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
			<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => confirmDelete(whispering, { collection: 'recordings', id: own })} data-testid="delete-recording">
				Delete recording
			</Button>
		</div>
	{/if}
</section>
