<!--
	A file opened beside the recordings, shown by what the folder holds of it.
	A transcript that reads shows its body, edited as a row. Any other text
	file, and a row file shown as text, shows its exact editable text. Each is
	an edit over the file: what was typed shows until its save answers. Audio
	plays; any other file the folder does not keep as text is listed, not
	opened, and can still be renamed or deleted.
-->
<script lang="ts">
	import { readRow } from '@epicenter/folder';
	import { edit, fileEdit } from '@epicenter/svelte/folder';
	import RowIssues from '@epicenter/svelte/row-issues';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { getFolder } from '$lib/folder.js';

	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { basename, dirname } from '@epicenter/folder/file-browser';
	import { toast } from '@epicenter/ui/sonner';
	import { audioMimeTypeOf } from '$lib/audio-format.js';
	import { rowIdOf, TRANSCRIPTIONS, whisperingTables } from '$lib/definition.js';
	import { rowTableOf } from '$lib/whispering.svelte.js';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete, copyPath } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import { Textarea } from '@epicenter/ui/textarea';

	let {
		path,
		onBack,
	}: {
		/** The file shown. The parent keys this view by it. */
		path: string;
		/** Shown on narrow windows, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();
	const whispering = getWhispering();
	const folder = getFolder();

	// The parent keys this view by the file; what is typed is sent to that one.
	// svelte-ignore state_referenced_locally
	const own = path;
	const table = rowTableOf(own);
	const transcriptId = rowIdOf(TRANSCRIPTIONS, own);
	const file = $derived(folder.file(own));
	/** The file's text, when the folder holds it as text. */
	const text = $derived(typeof file?.data === 'string' ? file.data : undefined);
	const audio = $derived(audioMimeTypeOf(own) !== undefined);
	const stored = $derived(transcriptId === undefined ? undefined : folder.tables.transcriptions.row(transcriptId));
	/** A transcript that reads, shown as its body: its fields are kept. */
	const transcript = $derived(stored?.issues === null && !whispering.showsText(own) ? stored : undefined);

	const body = edit(
		() => (stored?.issues === null ? stored.body : ''),
		(body) => folder.tables.transcriptions.update(transcriptId ?? '', { body }),
	);
	const source = fileEdit(folder, own);
	/** Why the text shown does not read as a row, as it is typed. */
	const issues = $derived(
		table === undefined || text === undefined
			? undefined
			: (readRow(source.value, whisperingTables[table]).issues ?? undefined),
	);

	/** The view changes now; queued edits keep their order. */
	function show(toSource: boolean) {
		const problem = toSource ? whispering.editSource(own) : whispering.useForm(own, source.value);
		if (problem)
			toast.error(toSource ? 'The text was not opened for editing' : 'The text was not opened alone', {
				description: problem,
			});
	}

	const name = $derived(basename(path));
	const directory = $derived(dirname(path));
	/** The recording whose row names this file as its audio, if one does. */
	const owner = $derived(whispering.recordingNaming(path));

	/** A file shown as details: its extension names the type. */
	function details() {
		const dot = name.lastIndexOf('.');
		return dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : 'File';
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

	{#if file === undefined}
		<Empty.Root class="flex-1">
			<Empty.Title>{name} is no longer in the folder</Empty.Title>
			<Empty.Description>It was renamed or deleted, here or by another program.</Empty.Description>
		</Empty.Root>
	{:else if file.readError && text === undefined}
		<Empty.Root class="flex-1" data-testid="file-read-error">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not read this file</Empty.Title>
			<Empty.Description>{file.readError.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => folder.refresh()}>Try again</Button>
		</Empty.Root>
	{:else if transcript}
		{#if file.readError}
			<div role="alert" class="border-b px-4 py-2 text-sm text-destructive">Could not read the latest file: {file.readError.message} <Button variant="outline" size="xs" onclick={() => void folder.refresh()}>Try again</Button></div>
		{/if}
		<div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3 sm:px-4">
			<p class="text-xs text-muted-foreground">
				The transcript’s text, the body of its file. Its fields are kept as they are.
				<Button size="xs" variant="outline" class="ml-1" onclick={() => void show(true)}>Edit the whole file</Button>
			</p>
			<Textarea
				class="min-h-40 flex-1 resize-none font-sans"
				bind:value={body.value}
				aria-label="Contents of {name}"
			/>
		</div>
	{:else if text !== undefined}
		{#if file.readError}
			<div role="alert" class="border-b px-4 py-2 text-sm text-destructive">Could not read the latest file: {file.readError.message} <Button variant="outline" size="xs" onclick={() => void folder.refresh()}>Try again</Button></div>
		{/if}
		{#if issues}
			<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					This file does not read as a row yet. Fix it here; it saves as you type.
				</p>
				<RowIssues {issues} />
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
				bind:value={source.value}
				{@attach () => { if (table !== undefined) whispering.editSource(own); }}
				aria-label="Contents of {name}"
				spellcheck={false}
			/>
		</div>
	{:else if file.data !== undefined}
		<Empty.Root class="flex-1" data-testid="file-not-text">
			<Empty.Media><FileIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>{details()}</Empty.Title>
			<Empty.Description>
				This file is not UTF-8 text, so it is listed here but not opened for editing. Rename and delete still work on it.
			</Empty.Description>
		</Empty.Root>
	{:else if audio}
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-4" data-testid="audio-file-view">
			<AudioPlayer {path} label="Audio in {name}" />
			<dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
				<dt class="text-muted-foreground">Type</dt>
				<dd>{details()} · {audioMimeTypeOf(path)}</dd>
				<dt class="text-muted-foreground">Recording</dt>
				<dd>
					{#if owner}
						<Button variant="link" class="h-auto p-0" onclick={() => whispering.open(owner.path)}>
							{owner.row.fields.title || owner.path}
						</Button>
					{:else}
						No recording row names this file.
					{/if}
				</dd>
			</dl>
		</div>
	{:else}
		<Empty.Root class="flex-1" data-testid="file-not-opened">
			<Empty.Media><FileIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>{details()}</Empty.Title>
			<Empty.Description>
				Whispering does not open this kind of file, so it is listed here but not opened. Rename and delete still work on it.
			</Empty.Description>
		</Empty.Root>
	{/if}
	<UnsavedEdit edit={body} />
	<UnsavedEdit edit={source} />

	<FileNameBar
		prefix={directory === '' ? '' : `${directory}/`}
		{name}
		onRename={(name) => whispering.rename(own, name)}
		onDelete={() => void confirmDelete(whispering, path)}
	/>
</section>
