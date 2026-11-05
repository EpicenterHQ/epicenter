<!--
	The web app's header account of its store: the recordings are kept in
	this browser's storage for this site, for good (ADR-0700). Signing in
	changes nothing here: it adds hosted transcription and AI, never storage.
-->
<script lang="ts">
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';

	const status: StatusLine = {
		label: 'On this browser',
		detail:
			'Your recordings are kept in this browser’s storage for this site. They never upload; signing in only adds hosted transcription and AI.',
		tone: 'neutral',
	};
</script>

<StatusPopover summary={status} details={[{ name: 'Files', testid: 'status-files', line: status }]}>
	<StatusRow name="Kept in" class="text-xs break-all" data-testid="status-folder">
		This browser’s storage for this site
	</StatusRow>
</StatusPopover>
