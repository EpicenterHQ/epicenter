<!--
	Mounts one real view inside the folder context and tooltip provider the
	layout supplies: the timeline, or the open capture as its text and
	thoughts or as text, as the store shows it now.
-->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Captures } from '$lib/captures.svelte.js';
	import type { CaptureFolder } from '$lib/captures.svelte.js';
	import { setFolder } from '$lib/folder.js';
	import CaptureDetail from '../CaptureDetail.svelte';
	import TextDetail from '../TextDetail.svelte';
	import Timeline from '../Timeline.svelte';

	let { captures, folder }: { captures: Captures; folder: CaptureFolder } = $props();
	// svelte-ignore state_referenced_locally
	setFolder(folder);
	const item = $derived(captures.opened);
</script>

	<Tooltip.Provider>
		{#if item === undefined}
			<Timeline {captures} />
		{:else if item.mode === 'capture'}
			{#key item}<CaptureDetail {captures} stem={item.stem} />{/key}
		{:else}
			{#key item}<TextDetail {captures} stem={item.stem} />{/key}
		{/if}
	</Tooltip.Provider>
