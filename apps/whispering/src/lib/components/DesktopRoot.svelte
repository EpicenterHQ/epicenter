<!--
	The desktop window's root over its open data folder: it sets the folder's
	sync for the header and Settings (`setFolderSync`): its path, whether
	Epicenter syncs it, Sync with Epicenter, and Choose data folder…, which
	remembers the choice in the AppData root's `settings.md`. The app over
	the folder is `children`.
-->
<script lang="ts">
	import { APPS } from '@epicenter/constants/apps';
	import type { Client } from '@epicenter/definition/contract';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import type { Snippet } from 'svelte';
	import type { WhisperingSettings } from '../settings.tauri.js';

	let { appData, children }: { appData: Client<WhisperingSettings>; children: Snippet } = $props();

	/**
	 * Where Whispering's web app publishes its contract (`static/contract.json`):
	 * deployment, not data, so a constant here and not in the contract
	 * (decision 82).
	 */
	const CONTRACT_URL = `${APPS.WHISPERING.url}/contract.json`;

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ appData, contract: CONTRACT_URL }));
</script>

{@render children()}
