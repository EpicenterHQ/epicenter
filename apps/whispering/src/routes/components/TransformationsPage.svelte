<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { getLibrary } from '$lib/library.svelte.js';
	import TransformationDetail from './TransformationDetail.svelte';
	import TransformationList from './TransformationList.svelte';

	const library = getLibrary();
	const { ui } = library;

	/** Below this width, the list and the editor take turns. */
	const wide = new MediaQuery('(min-width: 768px)');

	async function back() {
		const id = library.selectedTransformationId;
		ui.showingTransformation = false;
		await tick();
		if (id !== undefined)
			document.querySelector<HTMLElement>(`[data-transformation="${CSS.escape(id)}"]`)?.focus();
	}
</script>

<svelte:head><title>Transformations · Whispering</title></svelte:head>

{#snippet detail(onBack: (() => void) | undefined)}
	{@const selected = library.selectedTransformation}
	{#if selected && (selected.note || selected.repair)}
		{#key selected.id}
			<TransformationDetail id={selected.id} note={selected.note} {onBack} />
		{/key}
	{:else}
		<Empty.Root class="h-full">
			{#if selected !== undefined}
				<Empty.Title>This transformation is no longer listed</Empty.Title>
				<Empty.Description>It was deleted, here or elsewhere. Results it produced are still saved.</Empty.Description>
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
{:else if ui.showingTransformation}
	{@render detail(back)}
{:else}
	<TransformationList onOpen={() => (ui.showingTransformation = true)} />
{/if}
