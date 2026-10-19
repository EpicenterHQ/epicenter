<!--
	The header over the local folder: the app's name, whether
	everything typed is saved on this device, the theme, and Files. It
	offers no Save version, Sync, or Connect: this storage keeps no versions
	and syncs nowhere yet.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import type { Notes } from '$lib/notes.svelte.js';

	let {
		notes,
		filesOpen,
		onToggleFiles,
	}: {
		notes: Notes;
		filesOpen: boolean;
		onToggleFiles: () => void;
	} = $props();

	const saves = $derived(notes.saves);
</script>

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold">Honeycrisp</h1>

	<StatusPopover summary={saves} details={[{ name: 'Saves', testid: 'status-saves', line: saves }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-folder">This device</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				Notes are saved on this device. Honeycrisp keeps no versions and does not sync them to other devices yet.
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
