<!--
	The header: the app's name, then the build's account of the store
	(`#platform/chrome`): where the todos are, whether they read, and the
	account on the web or the folder's sync on the desktop.
-->
<script lang="ts">
	import Chrome from '#platform/chrome';

	let { pendingNewTodo }: { pendingNewTodo: boolean } = $props();
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
	<!-- On narrow screens the list itself says what this is; the width goes to status. -->
	<h1 class="text-sm font-semibold max-sm:sr-only">Todos</h1>
	<Chrome {pendingNewTodo} />
</header>
