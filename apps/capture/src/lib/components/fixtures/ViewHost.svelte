<!--
	Mounts one real view with what the layout supplies (tooltips, the
	confirmation dialog, toasts): the timeline, or the open capture as its
	text and thoughts or as text, as the store shows it now.
-->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import type { Captures } from '$lib/captures.svelte.js';
	import CaptureDetail from '../CaptureDetail.svelte';
	import TextDetail from '../TextDetail.svelte';
	import Timeline from '../Timeline.svelte';

	let { captures }: { captures: Captures } = $props();
	const item = $derived(captures.opened);
</script>

<Tooltip.Provider>
	{#if item === undefined}
		<Timeline {captures} />
	{:else if item.mode === 'capture'}
		{#key item}<CaptureDetail {captures} id={item.id} />{/key}
	{:else}
		{#key item}<TextDetail {captures} id={item.id} />{/key}
	{/if}
</Tooltip.Provider>
<ConfirmationDialog />
<Toaster />
