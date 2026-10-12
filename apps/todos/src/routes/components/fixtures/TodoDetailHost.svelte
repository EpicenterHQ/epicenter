<!--
	Mounts the real Detail as TodosView does: the detail pane for whatever the
	store shows now, inside the folder's scope and the tooltip provider. "Hide
	detail" unmounts the whole pane while the store and its cache stay, as the
	narrow layout's Back does.
-->
<script lang="ts">
	import type { Todos } from '$lib/todos.svelte.js';
	import Detail from '../Detail.svelte';
	import TodoList from '../TodoList.svelte';
	import QueryHost from './QueryHost.svelte';

	let { todos, list = false }: { todos: Todos; list?: boolean } = $props();
	let shown = $state(true);
</script>

<button type="button" data-host="toggle" onclick={() => (shown = !shown)}>
	{shown ? 'Hide detail' : 'Show detail'}
</button>
<QueryHost {todos}>
	{#if list}
		<div data-host="list"><TodoList /></div>
	{/if}
	{#if shown}
		<div data-host="detail"><Detail /></div>
	{:else}
		<p data-view="hidden">The detail is hidden</p>
	{/if}
</QueryHost>
