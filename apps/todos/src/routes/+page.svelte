<!--
	Todos over its one store, which `$lib/app` opened before this page ran:
	the person's `todos` repository on the web, where every edit is a commit
	and nothing is kept in the browser, or the desktop window's folder. A
	store that did not open is `+error.svelte`'s recovery screen.
-->
<script lang="ts">
	import TodosApp from '$lib/components/TodosApp.svelte';
</script>

<TodosApp />
