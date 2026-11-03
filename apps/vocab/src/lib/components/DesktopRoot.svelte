<!--
	The desktop window's root over its two open roots: it wraps the data
	folder once for Svelte, here where it is open, and sets its words, chats
	and messages for every page under it (`setEntryList`, `setChatList`,
	`setMessageList`), and the folder's sync for the header (`setFolderSync`). The pages hold
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
	import { CONTRACT_URL, type VocabSettings } from '../folder.tauri.js';
	import { setChatList, setEntryList, setMessageList } from '../vocab.svelte.js';

	let {
		appData,
		device,
		children,
	}: { appData: Client<VocabSettings>; device: Client<Vocab>; children: Snippet } = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	const files = fromClient(device);
	setEntryList(files.entries);
	setChatList(files.chats);
	setMessageList(files.messages);
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ device, contract: CONTRACT_URL }));
</script>

{#key auth.state.account}
	{@render children()}
{/key}
