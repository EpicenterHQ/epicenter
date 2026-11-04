<!--
	The desktop window's root over its open data folder: it wraps the folder
	once for Svelte, here where it is open, and sets its words, chats and
	messages for every page under it (`setEntryList`, `setChatList`,
	`setMessageList`), and the folder's sync for the header (`setFolderSync`).
	Signing in or out changes only what the hosted models offer, which the
	pages follow; nothing renders again.
-->
<script lang="ts">
	import { displayPath } from '@epicenter/folder/tauri';
	import type { Vocab } from '../contract.js';
	import type { Client } from '@epicenter/definition/contract';
	import { fromClient } from '@epicenter/svelte/client';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import type { Snippet } from 'svelte';
	import { setChatList, setEntryList, setMessageList } from '../vocab.svelte.js';

	let { device, site, children }: { site: string; device: Client<Vocab>; children: Snippet } = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	const files = fromClient(device);
	setEntryList(files.entries);
	setChatList(files.chats);
	// svelte-ignore state_referenced_locally
	setMessageList(device.messages);
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ path: displayPath(device), site }));
</script>

{@render children()}
