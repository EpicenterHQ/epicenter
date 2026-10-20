<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import { todosTables } from '$lib/definition.js';
	import TodosView from './local/TodosView.svelte';
</script>

<FolderApp title="Todos" tables={todosTables}>
	{#snippet children(context)}
		<TodosView {context} />
	{/snippet}
</FolderApp>
