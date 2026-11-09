<!--
	Where a folder on this computer is, and a button that shows it. A Tauri
	window's view: the shell's code loads when the button is pressed.
-->
<script lang="ts">
	import ShowFolderButton from './show-folder-button.svelte';

	let { noun, path, pathTestId = 'folder-onboarding-path' }: { noun: string; path: string; pathTestId?: string } = $props();

	const reveal = async () => (await import('@epicenter/folder/tauri')).revealRoot('Data');
</script>

<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="folder-onboarding">
	<span>Your {noun} are files in <span class="break-all" data-testid={pathTestId}>{path}</span>.</span>
	<ShowFolderButton {reveal} />
</div>
