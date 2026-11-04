<!--
	The desktop window's root over its two open roots: it wraps the data
	folder once for Svelte, here where it is open, and sets its notes and
	folders for every page under it (`setNotes`, `setFolders`), and the
	folder's sync for the header (`setFolderSync`).
-->
<script lang="ts">
	import { displayPath } from '@epicenter/folder/tauri';
	import type { Honeycrisp } from '../contract.js';
	import type { Client } from '@epicenter/definition/contract';
	import { fromClient } from '@epicenter/svelte/client';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import type { Snippet } from 'svelte';
		import { setFolders, setNotes } from '../honeycrisp.svelte.js';

	let {
		device,
		site,
		children,
	}: { site: string; device: Client<Honeycrisp>; children: Snippet } = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	const files = fromClient(device);
	setNotes(files.notes);
	setFolders(files.folders);
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ path: displayPath(device), site }));
</script>

{@render children()}
