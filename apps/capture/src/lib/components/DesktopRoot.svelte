<!--
	The desktop window's root over its two open roots: it sets them, each
	wrapped once, for every page under it (`setAppData`, `setDevice`), and
	the data folder's sync for the header (`setFolderSync`).
-->
<script lang="ts">
	import type { Capture } from '@epicenter/capture';
	import type { Client } from '@epicenter/definition/contract';
	import { fromClient } from '@epicenter/svelte/client';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import type { Snippet } from 'svelte';
	import { CONTRACT_URL, type CaptureSettings, setAppData, setDevice } from '../folder.tauri.js';

	let {
		appData,
		device,
		children,
	}: { appData: Client<CaptureSettings>; device: Client<Capture>; children: Snippet } = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	setAppData(fromClient(appData));
	// svelte-ignore state_referenced_locally
	setDevice(fromClient(device));
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ appData, contract: CONTRACT_URL }));
</script>

{@render children()}
