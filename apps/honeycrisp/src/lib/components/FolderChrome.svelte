<!--
	When the folder is on this computer (`folder.reveal`): the header's account
	of its store, Honeycrisp's folder on this computer, whether Epicenter
	manages it, and Set up in Epicenter until it does. It offers no sign-in
	yet: signing in syncs the folder, and this app's shell has no account until
	it does (ADR-0785).
-->
<script lang="ts">
	import { APPS } from '@epicenter/definition/site';
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import FolderOnboarding from '@epicenter/svelte/folder-onboarding';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { folder } from '../app.js';

	let {
		unavailable,
	}: {
		/** Why the store cannot be reached now (`folder.unavailable()`), if it cannot. */
		unavailable: { message: string } | null;
	} = $props();

	// `<WhenOpen>` renders the pages, and so this, only over the open folder.
	const sync = folderSync({ path: folder.displayPath() ?? '', site: APPS.HONEYCRISP.url });

	const status = $derived.by((): StatusLine => {
		if (unavailable !== null) return { label: 'Not readable here', detail: unavailable.message, tone: 'error' };
		if (sync.managed) return { label: 'Kept by Epicenter', tone: 'good' };
		return { label: 'On this computer', tone: 'neutral' };
	});
</script>

<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
	<StatusRow name="Where">
		<span class="font-medium" data-testid="status-where">This computer</span>
		<FolderOnboarding noun="notes" path={sync.path} pathTestId="status-folder" />
		<span class="mt-0.5 block text-xs text-muted-foreground">
			{#if sync.managed}
				Epicenter keeps its local history. Connect a repository there to use it on other devices.
			{:else}
				Plain Markdown files. Set up Epicenter to keep their history, then connect a repository to use them elsewhere.
			{/if}
		</span>
	</StatusRow>
</StatusPopover>
<div class="ml-auto flex min-w-0 items-center gap-1">
	<FolderSyncActions {sync} />
	<LightSwitch variant="ghost" />
</div>
