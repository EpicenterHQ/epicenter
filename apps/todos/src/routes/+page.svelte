<script lang="ts">
	import { openFolder } from '@epicenter/folder';
	import OpenFolder from '@epicenter/svelte/open-folder';
	import { todosTables } from '$lib/definition.js';
	import TodosApp from './local/TodosApp.svelte';
</script>

<OpenFolder open={() => openFolder({ tables: todosTables })}>
	{#snippet children(folder)}
		<TodosApp {folder} />
	{/snippet}
</OpenFolder>
