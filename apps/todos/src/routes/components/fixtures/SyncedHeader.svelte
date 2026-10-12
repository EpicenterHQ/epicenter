<!-- The page's Sync mutation, created inside the query client's context, handed to the header. -->
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { getTodos } from '$lib/todos.svelte.js';
	import AppHeader from '../AppHeader.svelte';

	const todos = getTodos();

	const sync = createMutation(() => todos.sync.run.options);
</script>

<AppHeader {sync} />
