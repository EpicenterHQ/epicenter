<!--
	The desktop window's root over its two open roots: it reads the data
	folder as a folder through `reactive`, once, here where it is open, and
	sets its notes and folders for every page under it (`setNotes`,
	`setFolders`), and the folder's sync for the header (`setFolderSync`).
	Leaving the page while a save is out asks first.
-->
<script lang="ts">
	import { displayPath } from '@epicenter/folder/tauri';
	import type { Honeycrisp } from '../contract.js';
	import type { Client } from '@epicenter/definition/contract';
	import { folderOf } from '@epicenter/folder/core';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import LeaveGuard from '@epicenter/svelte/leave-guard';
	import { reactive } from '@epicenter/svelte/reactive';
	import type { Snippet } from 'svelte';
	import { setFolders, setNotes } from '../honeycrisp.svelte.js';

	let {
		device,
		site,
		children,
	}: { site: string; device: Client<Honeycrisp>; children: Snippet } = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	const folder = reactive(folderOf(device));
	setNotes(folder.notes);
	setFolders(folder.folders);
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ path: displayPath(device), site }));
</script>

<LeaveGuard {folder} />

{@render children()}
