<!--
	The header's account of the store when the folder is on this computer
	(`folder.reveal`): the data folder Whispering keeps its recordings in.
	Whispering never syncs anything itself (ADR-0822).
-->
<script lang="ts">
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import { folder } from '../app.js';

	// `<WhenOpen>` renders the app, and so this, only over the open data folder.
	const path = folder.displayPath() ?? '';

	const status: StatusLine = { label: 'On this computer', tone: 'neutral' };
</script>

<StatusPopover summary={status} details={[{ name: 'Files', testid: 'status-files', line: status }]}>
	<StatusRow name="Kept in">
		<span class="font-medium" data-testid="status-where">This computer</span>
		<span class="mt-0.5 block break-all text-xs text-muted-foreground" data-testid="status-folder">{path}</span>
		<span class="mt-0.5 block text-xs text-muted-foreground">A Markdown note per recording beside its audio.</span>
	</StatusRow>
</StatusPopover>
