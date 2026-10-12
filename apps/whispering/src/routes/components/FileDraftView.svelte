<!--
	An open file other than a recording, in the shared FileView. Whispering
	adds two bodies of its own: a transcript's text, edited as the body of its
	row with its fields kept, and an audio file's player and the recording
	that names it.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toast } from '@epicenter/ui/sonner';
	import { wellFormed } from '@epicenter/folder';
	import { basename, withFileNewlines } from '@epicenter/folder/file-browser';
	import { FileView, type FileViewItem, fileDetails } from '@epicenter/svelte/folder-ui';
	import SaveBar from '@epicenter/svelte/save-bar';
	import { audioMimeTypeOf } from '$lib/audio-format.js';
	import { TRANSCRIPTIONS, whisperingDefinition } from '$lib/definition.js';
	import type { Draft, Library } from '$lib/library.svelte.js';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete, lf, openItem } from './file-actions.js';

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
	const transcript = $derived(draft.kind === 'row' && draft.table === TRANSCRIPTIONS ? draft.session : undefined);
	/** What the shared view shows itself; a transcript and audio are this view's own. */
	const item = $derived.by((): FileViewItem | undefined => {
		switch (draft.kind) {
			case 'row':
			case 'audio':
				return undefined;
			case 'binary':
			case 'tooLarge':
				return { kind: draft.kind, size: draft.size };
			default:
				return draft;
		}
	});
	const name = $derived(basename(path));
	/** The recording whose row names this file as its audio, if one does. */
	const owner = $derived(library.recordingNaming(path));

	async function show(source: boolean) {
		const problem = source ? await library.editSource(path) : await library.useForm(path);
		if (problem)
			toast.error(source ? 'The text was not opened for editing' : 'The text was not opened alone', {
				description: problem,
			});
	}
</script>

<FileView
	{path}
	{item}
	row={draft.kind === 'text' && draft.table !== undefined
		? { table: whisperingDefinition.tables[draft.table], noun: 'row' }
		: undefined}
	notice={draft.kind === 'text' && draft.table === TRANSCRIPTIONS ? wholeFileNotice : undefined}
	backLabel="Back to recordings"
	{onBack}
	onRetry={() => void openItem(library, path)}
	onReloadTheirs={(session) => library.reloadTheirs(session)}
	onKeepMine={(session) => library.keepMine(session)}
	canKeepMine={(session) => library.canKeepMine(session)}
	onRename={(next) => library.rename(path, next)}
	onDelete={() => void confirmDelete(library, path)}
>
	{#if transcript}
		<SaveBar
			save={transcript.state}
			onRetry={() => transcript.retry()}
			onReloadTheirs={() => library.reloadTheirs(transcript)}
			gone={!library.canKeepMine(transcript)}
			onKeepMine={library.canKeepMine(transcript) ? () => library.keepMine(transcript) : undefined}
		/>
		<div class="flex min-h-48 flex-1 flex-col gap-2 px-3 py-3 sm:px-4">
			<p class="text-xs text-muted-foreground">
				The transcript’s text, the body of its file. Its fields are kept as they are.
				<Button size="xs" variant="outline" class="ml-1" onclick={() => void show(true)}>Edit the whole file</Button>
			</p>
			<Textarea
				class="min-h-40 flex-1 resize-none font-sans"
				bind:value={
					() => lf(transcript?.draft.body ?? ''),
					(value) =>
						transcript?.edit((row) => {
							row.body = withFileNewlines(wellFormed(value), row.body);
						})
				}
				disabled={transcript.locked}
				aria-label="Contents of {name}"
			/>
		</div>
	{:else if draft.kind === 'audio'}
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-4" data-testid="audio-file-view">
			<AudioPlayer source={{ kind: 'file', files: library.folder.files, path, generation: library.generation }} label="Audio in {name}" />
			<dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
				<dt class="text-muted-foreground">Type</dt>
				<dd>{fileDetails(name, draft.size)} · {audioMimeTypeOf(path)}</dd>
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
	{/if}
</FileView>

{#snippet wholeFileNotice()}
	The whole file, as its text. It saves as typed.
	<Button size="xs" variant="outline" class="ml-1" onclick={() => void show(false)}>Edit the text only</Button>
{/snippet}
