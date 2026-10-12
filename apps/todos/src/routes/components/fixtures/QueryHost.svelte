<!-- What the page supplies to the views: the folder's scope, and the tooltip provider the layout adds. -->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Snippet } from 'svelte';
	import type { Todos } from '$lib/todos.svelte.js';
	import FolderScope from '../FolderScope.svelte';

	let { todos, children }: { todos: Todos; children: Snippet } = $props();
</script>

<FolderScope {todos}>
	<Tooltip.Provider>{@render children()}</Tooltip.Provider>
</FolderScope>
