<script lang="ts">
	import type { Opened } from '@epicenter/folder/next';
	import OpenFolder from '@epicenter/svelte/open-folder';
	import { Toaster } from '@epicenter/ui/sonner';

	let { open }: { open: () => Opened<Record<never, never>> } = $props();
</script>

<OpenFolder {open} holdWindowClose={false}>
	{#snippet children(folder)}
		<button onclick={() => void folder.write('a.md', 'Changed text')}>Change file</button>
	{/snippet}
</OpenFolder>
<Toaster closeButton />
