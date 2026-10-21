<!--
	Test fixture: the recordings page's and the transformations page's detail
	views, rendered as those pages render them, each keyed by its path.
	`shown` unmounts the views, as closing the details does, while Whispering
	and its cache stay.
-->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { setWhispering, type Whispering } from '$lib/whispering.svelte.js';
	import { setFolder, type WhisperingContext } from '$lib/folder.js';
	import FileView from '../FileView.svelte';
	import RecordingDetail from '../RecordingDetail.svelte';
	import TransformationDetail from '../TransformationDetail.svelte';

	let { whispering, context, page }: { whispering: Whispering; context: WhisperingContext; page: { shown: boolean; tab: 'recordings' | 'transformations' } } =
		$props();
	// svelte-ignore state_referenced_locally
	setWhispering(whispering);
	// svelte-ignore state_referenced_locally
	// The test mounts the same opened context as the product root.
	// svelte-ignore state_referenced_locally
	setFolder(context);
</script>

<QueryClientProvider client={context.queryClient}>
<Tooltip.Provider>
	{#if page.shown && page.tab === 'recordings'}
		{@const selection = whispering.selection}
		{#if selection?.kind === 'recording'}
			{#key selection.path}
				<RecordingDetail path={selection.path} entry={selection.entry} />
			{/key}
		{:else if selection?.kind === 'file'}
			{#key selection.path}
				<FileView path={selection.path} />
			{/key}
		{/if}
	{:else if page.shown && page.tab === 'transformations'}
		{@const selected = whispering.selectedTransformation}
		{#if selected}
			{#key selected.path}
				<TransformationDetail
					path={selected.path}
					entry={selected.entry}
					onOpenFile={() => {}}
				/>
			{/key}
		{/if}
	{/if}
</Tooltip.Provider>
</QueryClientProvider>
