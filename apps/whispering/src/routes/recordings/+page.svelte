<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { basename } from '@epicenter/folder/file-browser';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import FileView from '../components/FileView.svelte';
	import RecordingDetail from '../components/RecordingDetail.svelte';
	import RecordingList from '../components/RecordingList.svelte';

	const { library, view } = getWhispering();

	/**
	 * The table is the page. Opening a recording shows its details: beside the
	 * table on a wide window, where the table keeps its search, order, and
	 * ticks in view, and in place of it below this width. Closing the details
	 * gives the whole width back to the table and changes nothing else: the
	 * recording stays selected, and everything typed is already in its file.
	 */
	const wide = new MediaQuery('(min-width: 768px)');

	/** Close the details and put focus back on the row they were opened from. */
	async function close() {
		const path = library.selectedPath;
		view.showingDetail = false;
		await tick();
		if (path !== undefined)
			document.querySelector<HTMLElement>(`[data-recording="${CSS.escape(path)}"]`)?.focus();
	}
</script>

<svelte:head><title>Recordings · Whispering</title></svelte:head>

{#snippet detail(onBack: (() => void) | undefined, onClose: (() => void) | undefined)}
	{@const selection = library.selection}
	{#if selection?.kind === 'recording'}
		{#key selection.path}
			<RecordingDetail {library} path={selection.path} entry={selection.entry} {onBack} {onClose} />
		{/key}
	{:else if selection?.kind === 'file'}
		{#key selection.path}
			<FileView {library} path={selection.path} onBack={onBack ?? onClose} />
		{/key}
	{:else}
		<Empty.Root class="h-full">
			{#if library.selectedPath !== undefined}
				<Empty.Title>{basename(library.selectedPath)} is no longer in the folder</Empty.Title>
				<Empty.Description>It was renamed or deleted outside this window.</Empty.Description>
			{:else}
				<Empty.Title>Select a recording</Empty.Title>
				<Empty.Description>Its audio, transcripts, transformation results, notes, and source open here. Any other file opens from Files.</Empty.Description>
			{/if}
			{#if onBack ?? onClose}
				<Button variant="outline" size="sm" onclick={onBack ?? onClose}><ArrowLeftIcon /> Back to recordings</Button>
			{/if}
		</Empty.Root>
	{/if}
{/snippet}

{#if !view.showingDetail}
	<RecordingList onOpen={() => (view.showingDetail = true)} />
{:else if wide.current}
	<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
		<Resizable.Pane id="list" order={1} defaultSize={42} minSize={25}>
			<RecordingList onOpen={() => (view.showingDetail = true)} />
		</Resizable.Pane>
		<Resizable.Handle />
		<Resizable.Pane id="detail" order={2} defaultSize={58} minSize={35}>
			{@render detail(undefined, close)}
		</Resizable.Pane>
	</Resizable.PaneGroup>
{:else}
	{@render detail(close, undefined)}
{/if}
