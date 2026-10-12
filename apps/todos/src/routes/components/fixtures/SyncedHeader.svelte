<!-- The page's Sync mutation, created inside the query client's context, handed to the header. -->
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import type { Todos } from '$lib/todos.svelte.js';
	import AppHeader from '../AppHeader.svelte';

	let { todos }: { todos: Todos } = $props();
	const sync = createMutation(() => todos.sync.options);
</script>

<AppHeader {todos} {sync} filesOpen={false} terminalOpen={false} onToggleFiles={() => {}} onToggleTerminal={() => {}} />
