<!-- PROTOTYPE. Reads the world from context during setup: used as a later child and as a toast. -->
<script lang="ts">
	import { getWorld } from './world.js';

	let { where }: { where: string } = $props();
	const { todos } = getWorld();
</script>

<p data-testid="reader">{where} read the world: {todos.items.length} todos</p>
