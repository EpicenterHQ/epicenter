<!--
	Todos over its one store, which the variant's root opened: the person's
	`todos` repository on the web, where every edit is a commit and nothing
	is kept in the browser, or the desktop window's folder.
-->
<script lang="ts">
	import { store } from '#platform/root';
	import TodosApp from '$lib/components/TodosApp.svelte';

	const { todos } = store();
</script>

<TodosApp {todos} />
