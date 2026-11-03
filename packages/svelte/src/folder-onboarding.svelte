<script lang="ts">
	import ShowFolderButton from './show-folder-button.svelte';

	let { noun, path, pathTestId = 'folder-onboarding-path' }: { noun: string; path: string; pathTestId?: string } = $props();
</script>

<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="folder-onboarding">
	<span>Your {noun} are files in <span class="break-all" data-testid={pathTestId}>{path}</span>.</span>
	<ShowFolderButton root="Data" />
</div>
