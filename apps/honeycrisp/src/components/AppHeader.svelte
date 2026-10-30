<!--
	The header over the open repository: the app's name, the theme, and
	Files. Where the repository syncs, and what has not reached its server,
	is the shell's repository bar.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';

	let { filesOpen, onToggleFiles }: { filesOpen: boolean; onToggleFiles: () => void } = $props();
</script>

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold">Honeycrisp</h1>

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
