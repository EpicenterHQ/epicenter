<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { getLibrary } from '$lib/library.svelte.js';
	import RecordingDetail from './RecordingDetail.svelte';
	import RecordingList from './RecordingList.svelte';

	const library = getLibrary();
	const { ui } = library;

	/**
	 * The table is the page. Opening a recording shows its details: beside the
	 * table on a wide window, where the table keeps its search, order, and
	 * ticks in view, and in place of it below this width. Closing the details
	 * gives the whole width back to the table and changes nothing else: the
	 * recording stays selected, and everything typed is already in its note.
	 */
	const wide = new MediaQuery('(min-width: 768px)');

	/** Close the details and put focus back on the row they were opened from. */
	async function close() {
		const id = library.selectedId;
		ui.showingDetail = false;
		await tick();
		if (id !== undefined)
			document.querySelector<HTMLElement>(`[data-recording="${CSS.escape(id)}"]`)?.focus();
	}
</script>

<svelte:head><title>Recordings · Whispering</title></svelte:head>

{#snippet detail(onBack: (() => void) | undefined, onClose: (() => void) | undefined)}
	{@const selection = library.selection}
	{#if selection && (selection.note || selection.repair)}
		{#key selection.id}
			<RecordingDetail id={selection.id} note={selection.note} repair={selection.repair} {onBack} {onClose} />
		{/key}
	{:else}
		<Empty.Root class="h-full">
			{#if selection !== undefined && !library.listing}
				<Empty.Title>This recording is no longer listed</Empty.Title>
				<Empty.Description>It was deleted, here or elsewhere.</Empty.Description>
			{:else}
				<Empty.Title>Select a recording</Empty.Title>
				<Empty.Description>Its audio, transcripts, transformation results, and notes open here.</Empty.Description>
			{/if}
			{#if onBack ?? onClose}
				<Button variant="outline" size="sm" onclick={onBack ?? onClose}><ArrowLeftIcon /> Back to recordings</Button>
			{/if}
		</Empty.Root>
	{/if}
{/snippet}

{#if !ui.showingDetail}
	<RecordingList onOpen={() => (ui.showingDetail = true)} />
{:else if wide.current}
	<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
		<Resizable.Pane id="list" order={1} defaultSize={42} minSize={25}>
			<RecordingList onOpen={() => (ui.showingDetail = true)} />
		</Resizable.Pane>
		<Resizable.Handle />
		<Resizable.Pane id="detail" order={2} defaultSize={58} minSize={35}>
			{@render detail(undefined, close)}
		</Resizable.Pane>
	</Resizable.PaneGroup>
{:else}
	{@render detail(close, undefined)}
{/if}
