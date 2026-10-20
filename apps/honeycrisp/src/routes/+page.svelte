<!--
	Honeycrisp over this browser's local folder: `<FolderApp>` opens
	`openFolder({ tables: honeycrispTables })`, shows its loading and refusal
	screens, provides the folder to `HoneycrispApp`, and closes it when the page
	goes away.
-->
<script lang="ts">
	import { openFolder } from '@epicenter/folder';
	import FolderApp from '@epicenter/svelte/folder-app';
	import { honeycrispTables } from '$lib/data.js';
	import HoneycrispApp from './components/HoneycrispApp.svelte';
</script>

<FolderApp open={() => openFolder({ tables: honeycrispTables })}>
	{#snippet children(context)}
		<HoneycrispApp {context} />
	{/snippet}
</FolderApp>
