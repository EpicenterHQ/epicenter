<!--
	Mounts one real view inside the query client and tooltip provider the
	layout supplies: the timeline, or the open capture as its text and
	thoughts or as text, as the store shows it now.
-->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import type { Captures } from '$lib/captures.svelte.js';
	import CaptureDetail from '../CaptureDetail.svelte';
	import TextDetail from '../TextDetail.svelte';
	import Timeline from '../Timeline.svelte';

	let { captures }: { captures: Captures } = $props();
	const item = $derived(captures.opened);
</script>

<QueryClientProvider client={captures.queryClient}>
	<Tooltip.Provider>
		{#if item === undefined}
			<Timeline {captures} onCreated={() => {}} onRecover={() => {}} />
		{:else if item.mode === 'capture'}
			{#key item}<CaptureDetail {captures} stem={item.stem} />{/key}
		{:else}
			{#key item}<TextDetail {captures} stem={item.stem} />{/key}
		{/if}
	</Tooltip.Provider>
</QueryClientProvider>
