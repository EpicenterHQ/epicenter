<!--
	The header: the app's name, then the variant's account of the store
	(`Chrome` from `#platform/root`): where the todos are, whether they read,
	and the account on the web or the folder's sync on the desktop.
-->
<script lang="ts">
	import { Chrome } from '#platform/root';
	import { getTodos } from '$lib/todos.js';

	let { pendingNewTodo }: { pendingNewTodo: boolean } = $props();
	const todos = getTodos();
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
	<!-- On narrow screens the list itself says what this is; the width goes to status. -->
	<h1 class="text-sm font-semibold max-sm:sr-only">Todos</h1>
	<Chrome unreadable={todos.error} {pendingNewTodo} />
</header>
