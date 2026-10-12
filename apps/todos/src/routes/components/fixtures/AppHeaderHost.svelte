<!-- The header as TodosView mounts it, with the page's Sync, inside the folder's scope. -->
<script lang="ts">
	import type { Todos } from '$lib/todos.svelte.js';
	import QueryHost from './QueryHost.svelte';
	import SyncedHeader from './SyncedHeader.svelte';

	let { todos }: { todos: Todos } = $props();
</script>

<QueryHost {todos}>
	<SyncedHeader />
</QueryHost>
