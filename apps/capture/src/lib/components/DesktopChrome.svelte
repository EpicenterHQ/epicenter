<!--
	`#platform/chrome` in the desktop window: the header's account of its
	store, Capture's folder on this computer, whether Epicenter manages it,
	and Set up in Epicenter until it does. It never signs in.
-->
<script lang="ts">
	import { APPS } from '@epicenter/definition/site';
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import FolderOnboarding from '@epicenter/svelte/folder-onboarding';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { folder } from '../app.js';

	// `<WhenOpen>` renders the pages, and so this, only over the open folder.
	const sync = folderSync({ path: folder.displayPath() ?? '', site: APPS.CAPTURE.url });

	const status = $derived.by((): StatusLine => {
		const unreadable = folder.captures.error();
		if (unreadable !== null)
			return { label: 'Not readable here', detail: unreadable.message, tone: 'error' };
		if (sync.managed) return { label: 'Kept by Epicenter', tone: 'good' };
		return { label: 'On this computer', tone: 'neutral' };
	});
</script>

<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
	<StatusRow name="Where">
		<span class="font-medium" data-testid="status-where">This computer</span>
		<FolderOnboarding noun="captures" path={sync.path} />
		<span class="mt-0.5 block text-xs text-muted-foreground">
			{#if sync.managed}
				Epicenter keeps its local history. Connect a repository in Epicenter to use it on other devices.
			{:else}
				Set it up in Epicenter to keep its history and connect a repository.
			{/if}
		</span>
	</StatusRow>
</StatusPopover>
<div class="ml-auto flex min-w-0 items-center gap-2">
	<FolderSyncActions {sync} />
</div>
