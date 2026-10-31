<!--
	The desktop window's root over its two open roots, each wrapped once for
	Svelte here. It sets the folder's sync for the header and Settings
	(`setFolderSync`): its path, whether Epicenter syncs it, Sync with
	Epicenter, and Choose data folder…, which remembers the choice in the
	AppData root's `settings.md`. It holds the global shortcut that
	`shortcuts.md` resolves to, from both roots (`setGlobalShortcut`). The
	app over the folder is `children`, given the data folder wrapped here,
	the one place it is (decision 87).
-->
<script lang="ts">
	import { APPS } from '@epicenter/constants/apps';
	import type { Client } from '@epicenter/definition/contract';
	import { fromClient, type ReactiveClient } from '@epicenter/svelte/client';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import type { Snippet } from 'svelte';
	import type { Whispering } from '../contract.js';
	import { globalShortcut, setGlobalShortcut } from '../platform/shortcut.tauri.svelte.js';
	import type { WhisperingSettings } from '../settings.tauri.js';

	let {
		appData,
		device,
		children,
	}: {
		appData: Client<WhisperingSettings>;
		device: Client<Whispering>;
		children: Snippet<[ReactiveClient<Whispering>]>;
	} = $props();

	/**
	 * Where Whispering's web app publishes its contract (`static/contract.json`):
	 * deployment, not data, so a constant here and not in the contract
	 * (decision 82).
	 */
	const CONTRACT_URL = `${APPS.WHISPERING.url}/contract.json`;

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ appData, contract: CONTRACT_URL }));
	// svelte-ignore state_referenced_locally
	const files = fromClient(device);
	// svelte-ignore state_referenced_locally
	setGlobalShortcut(globalShortcut({ appData: fromClient(appData), device: files }));
</script>

{@render children(files)}
