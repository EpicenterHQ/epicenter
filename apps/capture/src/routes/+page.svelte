<script lang="ts">
	import { captureTables } from '@epicenter/capture';
	import FolderApp from '@epicenter/svelte/folder-app';
	import CaptureApp from '$lib/components/CaptureApp.svelte';
</script>

<FolderApp title="Capture" tables={captureTables}>
	{#snippet children(context)}
		<CaptureApp {context} />
	{/snippet}
</FolderApp>
