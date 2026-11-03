<!--
	The desktop window's root over its two open roots: it sets the data
	folder's captures, wrapped once for Svelte here where it is open, for
	every page under it (`setCaptureList`), and the folder's sync for the
	header (`setFolderSync`).
-->
<script lang="ts">
	import type { Capture } from '@epicenter/capture';
	import type { Client } from '@epicenter/definition/contract';
	import { fromClient } from '@epicenter/svelte/client';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import type { Snippet } from 'svelte';
	import { setCaptureList } from '../captures.svelte.js';

	let {
		device,
		site,
		children,
	}: { site: string; device: Client<Capture>; children: Snippet } = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	setCaptureList(fromClient(device).captures);
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ device, site }));
</script>

{@render children()}
