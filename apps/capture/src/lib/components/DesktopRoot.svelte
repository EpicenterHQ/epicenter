<!--
	The desktop window's root over its two open roots: it reads the data
	folder through `reactive` once here, where it is open, and sets its
	captures for every page under it (`setCaptureList`) and the folder's sync
	for the header (`setFolderSync`). While a write to it is out, reloading
	the page asks first; closing the window does not ask.
-->
<script lang="ts">
	import { displayPath } from '@epicenter/folder/tauri';
	import type { Capture } from '../model/index.js';
	import type { Client } from '@epicenter/definition/contract';
	import { folderOf } from '@epicenter/folder/core';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import { reactive } from '@epicenter/svelte/reactive';
	import { onMount, type Snippet } from 'svelte';
	import { on } from 'svelte/events';
	import { setCaptureList } from '../captures.svelte.js';

	let {
		device,
		site,
		children,
	}: { site: string; device: Client<Capture>; children: Snippet } = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	const folder = reactive(folderOf(device));
	setCaptureList(folder.captures);
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ path: displayPath(device), site }));

	onMount(() =>
		on(window, 'beforeunload', (event) => {
			if (folder.saving()) event.preventDefault();
		}),
	);
</script>

{@render children()}
