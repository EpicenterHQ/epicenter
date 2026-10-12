<!-- The whole Todos view as the page mounts it, inside what the layout supplies. -->
<script lang="ts">
	import { todos } from '$lib/todos.svelte.js';
	import TodosView from '../TodosView.svelte';
	import QueryHost from './QueryHost.svelte';

</script>

<QueryHost>
	<TodosView />
</QueryHost>
