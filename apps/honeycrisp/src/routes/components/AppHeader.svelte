<!--
	The header over this device's repository: the app's name, whether edits
	are still waiting to reach the server when the build syncs, the theme,
	and Files. It offers no Save version or Connect.
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import type { Notes } from '$lib/notes.svelte.js';

	let {
		notes,
		syncsTo,
		filesOpen,
		onToggleFiles,
	}: {
		notes: Notes;
		syncsTo?: string;
		filesOpen: boolean;
		onToggleFiles: () => void;
	} = $props();

	const status = $derived.by((): StatusLine => {
		if (syncsTo === undefined) return { label: 'On this device', tone: 'neutral' };
		const waiting = notes.unsent;
		return waiting === 0 ? { label: 'Synced', tone: 'good' } : { label: 'Sending…', detail: `${waiting} not sent yet`, tone: 'busy' };
	});
</script>

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold">Honeycrisp</h1>

	<StatusPopover summary={status} details={[{ name: 'Sync', testid: 'status-saves', line: status }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-folder">{syncsTo === undefined ? 'This device' : 'This device and a server'}</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				{syncsTo === undefined
					? 'Notes are kept on this device. This build of Honeycrisp syncs with no server.'
					: `Notes are kept on this device and synced through ${new URL(syncsTo).host}. Edits made offline are sent when it is back.`}
			</span>
		</StatusRow>
	</StatusPopover>

	<div class="ml-auto flex shrink-0 items-center gap-1">
		<LightSwitch variant="ghost" />
		<Button
			variant={filesOpen ? 'secondary' : 'ghost'}
			size="sm"
			tooltip={filesOpen ? 'Hide files (Ctrl+B)' : 'Show files (Ctrl+B)'}
			aria-pressed={filesOpen}
			onclick={onToggleFiles}
		>
			<FolderTreeIcon />
			Files
		</Button>
	</div>
</header>
