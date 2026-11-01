<!--
	The desktop window's root over its two open clients: it provides the data
	folder's todos to every page under it (`setTodos`), and the folder's sync
	to the header (`setFolderSync`).
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { fromClient } from '@epicenter/svelte/client';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import type { Snippet } from 'svelte';
	import type { Todos } from '../contract.js';
	import { CONTRACT_URL, type TodosSettings } from '../folder.tauri.js';
	import { setTodos } from '../todos.js';

	let {
		appData,
		device,
		children,
	}: { appData: Client<TodosSettings>; device: Client<Todos>; children: Snippet } = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	setTodos(fromClient(device).todos);
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ appData, device, contract: CONTRACT_URL }));
</script>

{@render children()}
