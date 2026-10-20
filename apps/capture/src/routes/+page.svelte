<script lang="ts">
	import { captureTables } from '@epicenter/capture';
	import { openFolder } from '@epicenter/folder';
	import FolderApp from '@epicenter/svelte/folder-app';
	import CaptureApp from '$lib/components/CaptureApp.svelte';
</script>

<FolderApp open={() => openFolder({ tables: captureTables })}>
	{#snippet children(context)}
		<CaptureApp {context} />
	{/snippet}
</FolderApp>
