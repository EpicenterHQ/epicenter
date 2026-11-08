<!--
	The header: the app's name, then the account of the store, by where the
	folder is: a folder on this computer, which can be shown in the file
	manager (`folder.reveal`, `FolderChrome`), or the person's repository
	(`RepositoryChrome`).
-->
<script lang="ts">
	import { folder } from '../app.js';
	import FolderChrome from './FolderChrome.svelte';
	import RepositoryChrome from './RepositoryChrome.svelte';

	let { pendingNewTodo }: { pendingNewTodo: boolean } = $props();
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
	<!-- On narrow screens the list itself says what this is; the width goes to status. -->
	<h1 class="text-sm font-semibold max-sm:sr-only">Todos</h1>
	{#if folder.reveal === null}
		<RepositoryChrome {pendingNewTodo} />
	{:else}
		<FolderChrome {pendingNewTodo} />
	{/if}
</header>
