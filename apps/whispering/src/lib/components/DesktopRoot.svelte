<!--
	The desktop window's root over its two open roots, each read as a folder
	through `reactive` once, here. It sets the folder's sync for the header
	and Settings (`setFolderSync`): its path, whether Epicenter manages local
	history, Set up in Epicenter, and shows the shell's folder path. It holds
	the global shortcut that `shortcuts.md` resolves to, from both roots
	(`setGlobalShortcut`), and asks before the page is left while the AppData
	folder is saving it. The app over the data folder is `children`, given
	that folder as made here, the one place it is (decision 87); the app
	guards its own writes (`WhisperingApp`).
-->
<script lang="ts">
	import { displayPath } from '@epicenter/folder/tauri';
	import type { Client } from '@epicenter/definition/contract';
	import { type Folder, folderOf } from '@epicenter/folder/core';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import LeaveGuard from '@epicenter/svelte/leave-guard';
	import { reactive } from '@epicenter/svelte/reactive';
	import type { Snippet } from 'svelte';
	import type { Whispering } from '../contract.js';
	import { globalShortcut, setGlobalShortcut } from '../platform/shortcut.tauri.svelte.js';
	import type { WhisperingSettings } from '../settings.tauri.js';

	let {
		appData,
		device,
		site,
		children,
	}: {
		appData: Client<WhisperingSettings>;
		device: Client<Whispering>;
		site: string;
		children: Snippet<[Folder<Whispering>]>;
	} = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ path: displayPath(device), site }));
	// svelte-ignore state_referenced_locally
	const files = reactive(folderOf(device));
	// svelte-ignore state_referenced_locally
	const settings = reactive(folderOf(appData));
	setGlobalShortcut(globalShortcut({ appData: settings, device: files }));
</script>

{@render children(files)}

<LeaveGuard folder={settings} />
