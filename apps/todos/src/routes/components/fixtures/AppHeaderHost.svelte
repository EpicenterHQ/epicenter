<!-- The header as TodosView mounts it, with the page's Sync, inside what the layout supplies. -->
<script lang="ts">
	import type { Todos } from '$lib/todos.svelte.js';
	import QueryHost from './QueryHost.svelte';
	import SyncedHeader from './SyncedHeader.svelte';

	let { todos }: { todos: Todos } = $props();
</script>

<QueryHost {todos}>
	<SyncedHeader {todos} />
</QueryHost>
