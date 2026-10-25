<script lang="ts">
	import type { SvelteFolder } from '@epicenter/svelte/folder-next';
	import FolderView from '../FolderView.svelte';

	let { folder }: { folder: SvelteFolder<Record<never, never>> } = $props();
</script>

<FolderView {folder} />
