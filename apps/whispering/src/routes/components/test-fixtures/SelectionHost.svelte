<!--
	Test fixture: the recordings page's and the transformations page's detail
	views, rendered as those pages render them, each keyed by its path.
	`shown` unmounts the views, as closing the details does, while Whispering
	and the folder stay.
-->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { setWhispering, type Whispering } from '$lib/whispering.svelte.js';
	import { setFolder, type WhisperingFolder } from '$lib/folder.js';
	import FileView from '../FileView.svelte';
	import RecordingDetail from '../RecordingDetail.svelte';
	import TransformationDetail from '../TransformationDetail.svelte';

	let { whispering, folder, page }: { whispering: Whispering; folder: WhisperingFolder; page: { shown: boolean; tab: 'recordings' | 'transformations' } } =
		$props();
	// svelte-ignore state_referenced_locally
	setWhispering(whispering);
	// The test mounts the same opened folder as the product root.
	// svelte-ignore state_referenced_locally
	setFolder(folder);
</script>

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
