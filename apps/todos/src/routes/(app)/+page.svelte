<!--
	Todos over its one store: in a browser, the person's repository the
	layout set (the online variant: every edit is a commit there, nothing is
	kept in the browser); in the desktop window, the window's folder
	(`Desktop`, loaded only there).
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import { isTauri } from '@tauri-apps/api/core';
	import TodosApp from '$lib/components/TodosApp.svelte';
	import type { Todos } from '$lib/contract.js';

	const online = isTauri() ? null : fromClient(getRepo<Todos>()).todos;
</script>

{#if online !== null}
	<TodosApp variant="online" todos={online} />
{:else}
	{#await import('$lib/components/Desktop.svelte') then { default: Desktop }}
		<Desktop />
	{/await}
{/if}
