<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { basename } from '@epicenter/folder/file-browser';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import TransformationDetail from '../components/TransformationDetail.svelte';
	import TransformationList from '../components/TransformationList.svelte';
	import { openItem } from '../components/file-actions.js';

	const { library, view } = getWhispering();

	/** Below this width, the list and the editor take turns. */
	const wide = new MediaQuery('(min-width: 768px)');

	async function back() {
		const path = library.selectedTransformationPath;
		view.showingTransformation = false;
		await tick();
		if (path !== undefined)
			document.querySelector<HTMLElement>(`[data-transformation="${CSS.escape(path)}"]`)?.focus();
	}

	/** A result is an ordinary file: its source opens beside the recordings, like any other file. */
	async function openFile(path: string) {
		if (!(await openItem(library, path))) return;
		view.showingDetail = true;
		await goto(resolve('/recordings'));
	}
</script>

<svelte:head><title>Transformations · Whispering</title></svelte:head>

{#snippet detail(onBack: (() => void) | undefined)}
	{@const selected = library.selectedTransformation}
	{#if selected}
		{#key selected.path}
			<TransformationDetail
				path={selected.path}
				entry={selected.entry}
				{onBack}
				onOpenFile={(path) => void openFile(path)}
			/>
		{/key}
	{:else}
		<Empty.Root class="h-full">
			{#if library.selectedTransformationPath !== undefined}
				<Empty.Title>{basename(library.selectedTransformationPath)} is no longer in the folder</Empty.Title>
				<Empty.Description>It was renamed or deleted outside this window. Results it produced are still saved.</Empty.Description>
			{:else}
				<Empty.Title>Select a transformation</Empty.Title>
				<Empty.Description>Its instructions and results open here, with a place to try it on pasted text.</Empty.Description>
			{/if}
			{#if onBack}
				<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to transformations</Button>
			{/if}
		</Empty.Root>
	{/if}
{/snippet}

{#if wide.current}
	<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
		<Resizable.Pane id="transformations" order={1} defaultSize={34} minSize={20}>
			<TransformationList />
		</Resizable.Pane>
		<Resizable.Handle />
		<Resizable.Pane id="transformation" order={2} defaultSize={66} minSize={30}>
			{@render detail(undefined)}
		</Resizable.Pane>
	</Resizable.PaneGroup>
{:else if view.showingTransformation}
	{@render detail(back)}
{:else}
	<TransformationList onOpen={() => (view.showingTransformation = true)} />
{/if}
