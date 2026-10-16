<!--
	A header's status for mounted tests: the shared lines, one app row, and an
	action in the footer, shown open.
-->
<script lang="ts">
	import StatusPopover, { type StatusDetail } from '../status-popover.svelte';
	import StatusRow from '../status-row.svelte';
	import type { StatusLine } from '../status-line.js';

	let {
		summary,
		details,
		onAction,
	}: {
		summary: StatusLine;
		details: readonly StatusDetail[];
		onAction: () => void;
	} = $props();
</script>

<StatusPopover open {summary} {details}>
	<StatusRow name="Folder" class="font-mono" data-testid="status-folder">/notes</StatusRow>
	{#snippet footer()}
		<button type="button" onclick={onAction}>Save version</button>
	{/snippet}
</StatusPopover>
