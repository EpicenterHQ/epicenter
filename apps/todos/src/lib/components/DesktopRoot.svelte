<!--
	The desktop window's root over its two open roots: it sets the data
	folder's todos, wrapped once for Svelte here where it is open, for every
	page under it (`setTodos`), and the folder's sync for the header
	(`setFolderSync`).
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { fromClient } from '@epicenter/svelte/client';
	import { folderSync, setFolderSync } from '@epicenter/svelte/folder-sync';
	import type { Snippet } from 'svelte';
	import type { Todos } from '../contract.js';
	import { CONTRACT_URL } from '../folder.tauri.js';
	import { setTodos } from '../todos.js';

	let {
		device,
		children,
	}: { device: Client<Todos>; children: Snippet } = $props();

	// Fixed for the component's life: Startup makes a new one for new roots.
	// svelte-ignore state_referenced_locally
	setTodos(fromClient(device).todos);
	// svelte-ignore state_referenced_locally
	setFolderSync(folderSync({ device, contract: CONTRACT_URL }));
</script>

{@render children()}
