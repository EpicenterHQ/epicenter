<!-- The header as TodosView mounts it, with the page's Sync, inside what the layout supplies. -->
<script lang="ts">
	import { todos } from '$lib/todos.svelte.js';
	import QueryHost from './QueryHost.svelte';
	import SyncedHeader from './SyncedHeader.svelte';

</script>

<QueryHost>
	<SyncedHeader />
</QueryHost>
