<!--
	The header: the app's name, then the account of the store, by where the
	folder is: a folder on this computer, which can be shown in the file
	manager (`folder.reveal`, `FolderChrome`), or the person's repository
	(`RepositoryChrome`).
-->
<script lang="ts">
	import { folder } from '$lib/app.js';
	import FolderChrome from './FolderChrome.svelte';
	import RepositoryChrome from './RepositoryChrome.svelte';
</script>

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold">Honeycrisp</h1>
	{#if folder.reveal === null}
		<RepositoryChrome unavailable={folder.unavailable()} />
	{:else}
		<FolderChrome unavailable={folder.unavailable()} />
	{/if}
</header>
