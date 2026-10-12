<!-- The page's Sync mutation, created inside the query client's context, handed to the header. -->
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { todos } from '$lib/todos.svelte.js';
	import AppHeader from '../AppHeader.svelte';

	const sync = createMutation(() => todos.sync.options);
</script>

<AppHeader {sync} filesOpen={false} terminalOpen={false} onToggleFiles={() => {}} onToggleTerminal={() => {}} />
