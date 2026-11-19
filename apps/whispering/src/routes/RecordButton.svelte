<!--
	Record, in the header. While a recording runs, `RecordingBar` under the
	header has its clock and Stop instead.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import { dictation } from '#lib/dictation.svelte.ts';
</script>

<Button disabled={dictation.status.kind !== 'idle'} onclick={() => dictation.toggle()}>
	<CircleIcon class="fill-current text-red-500" />
	Record
	<kbd class="font-sans text-xs opacity-70" title="Works from any app">⌘⇧;</kbd>
</Button>
