<!--
	The desktop window's header account of its store: Honeycrisp's folder on
	this computer, whether Epicenter syncs it, Sync with Epicenter until it
	does, and Choose data folder… (decisions 81 and 88). It never signs in.
-->
<script lang="ts">
	import { getFolderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import type { ChromeProps } from '../platform.js';

	let { unreadable }: ChromeProps = $props();

	// DesktopRoot renders the app, and so this, only over its open data folder.
	const sync = getFolderSync();

	const status = $derived.by((): StatusLine => {
		if (unreadable !== null) return { label: 'Not readable here', detail: unreadable.message, tone: 'error' };
		if (sync.state === 'synced') return { label: 'Synced by Epicenter', tone: 'good' };
		return { label: 'On this computer', tone: 'neutral' };
	});
</script>

<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
	<StatusRow name="Where">
		<span class="font-medium" data-testid="status-where">This computer</span>
		<span class="mt-0.5 block break-all text-xs text-muted-foreground" data-testid="status-folder">{sync.path}</span>
		<span class="mt-0.5 block text-xs text-muted-foreground">
			{#if sync.state === 'synced'}
				Epicenter keeps its history and syncs it.
			{:else}
				Plain Markdown files. Sync with Epicenter to keep their history and use them elsewhere.
			{/if}
		</span>
	</StatusRow>
	{#snippet footer()}
		<Button variant="outline" size="sm" disabled={sync.asking} onclick={() => sync.chooseDataFolder()}>Choose data folder…</Button>
	{/snippet}
</StatusPopover>
<div class="ml-auto flex min-w-0 items-center gap-1">
	<FolderSyncActions {sync} />
	<LightSwitch variant="ghost" />
</div>
