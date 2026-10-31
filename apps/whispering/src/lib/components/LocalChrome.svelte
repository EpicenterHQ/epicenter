<!--
	The web app's header account of its store: the recordings are kept in
	this browser's storage for this site, for good (ADR-0700).
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { ChromeProps } from '../platform/types.js';
	import { headerStatus, ON_THIS_BROWSER } from '../status.js';

	let { unwrittenAnswers }: ChromeProps = $props();

	const status = $derived(headerStatus({ unwrittenAnswers }, ON_THIS_BROWSER));
</script>

<StatusPopover summary={status} details={[{ name: 'Files', testid: 'status-files', line: status }]}>
	<StatusRow name="Kept in" class="text-xs break-all" data-testid="status-folder">
		This browser’s storage for this site
	</StatusRow>
</StatusPopover>
