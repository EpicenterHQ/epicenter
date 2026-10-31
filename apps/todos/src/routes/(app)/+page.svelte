<!--
	Todos over its one store: in a browser, the person's repository the
	layout set (the online variant: every edit is a commit there, nothing is
	kept in the browser); in the desktop window, the window's folder
	(`Desktop`, loaded only there).
-->
<script lang="ts">
	import { getRepo } from '@epicenter/svelte/repo';
	import { isTauri } from '@tauri-apps/api/core';
	import { Loading } from '@epicenter/ui/loading';
	import TodosApp from '$lib/components/TodosApp.svelte';
	import type { Todos } from '$lib/contract.js';

	const online = isTauri() ? null : getRepo<Todos>().todos;
</script>

{#if online !== null}
	<TodosApp variant="online" todos={online} />
{:else}
	<svelte:boundary>
		{#snippet pending()}
			<Loading class="h-dvh" />
		{/snippet}
		{#await import('$lib/components/Desktop.svelte') then { default: Desktop }}
			<Desktop />
		{/await}
	</svelte:boundary>
{/if}
