<!--
	The desktop window's root over its two open roots: it sets them, each
	wrapped once, for every page under it (`setAppData`, `setDevice`), and
	the data folder's sync for the header (`setFolderSync`). The pages hold
	one account for their life (the hosted models and dictation they open),
	so signing in or out renders them again over the same folder.
-->
<script lang="ts">
	import { auth } from '#platform/auth';
	import type { Vocab } from '../contract.js';
	import type { Client } from '@epicenter/definition/contract';
	import { fromClient } from '@epicenter/svelte/client';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import type { Snippet } from 'svelte';
	import { CONTRACT_URL, setAppData, setDevice, type VocabSettings } from '../folder.tauri.js';

	let {
		appData,
		device,
		children,
	}: { appData: Client<VocabSettings>; device: Client<Vocab>; children: Snippet } = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	setAppData(fromClient(appData));
	// svelte-ignore state_referenced_locally
	setDevice(fromClient(device));
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ appData, contract: CONTRACT_URL }));
</script>

{#key auth.state.account}
	{@render children()}
{/key}
