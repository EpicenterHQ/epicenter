<!--
	The data root once open (`data-folder.svelte`): the app's client over it,
	set for every component under it (`setRepo`), and its sync, set for the
	header (`getFolderSync()`).
-->
<script lang="ts">
	import type { Contract } from '@epicenter/definition/contract';
	import { type DataFolder, type DesktopFolder, openDevice } from '@epicenter/folder/tauri';
	import type { Snippet } from 'svelte';
	import { folderSync, setFolderSync } from './folder-sync.svelte.js';
	import { setRepo } from './repo.js';

	const {
		contract,
		desktop,
		folder,
		children,
	}: {
		contract: Contract;
		desktop: Pick<DesktopFolder, 'choose'>;
		folder: DataFolder;
		children: Snippet;
	} = $props();

	// The path the shell answered: the window's watched root, fixed for this
	// component's life.
	// svelte-ignore state_referenced_locally
	setRepo(openDevice(contract, { path: folder.path }));
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync(desktop, folder));
</script>

{@render children()}
