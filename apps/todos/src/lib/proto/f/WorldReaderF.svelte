<!-- PROTOTYPE. Awaits the world's promise: rendered as a toast, outside the layout's boundary. -->
<script lang="ts">
	import { world } from './app.js';

	let { where }: { where: string } = $props();
	const { todos } = await world;
</script>

<p data-testid="reader">{where} read the world: {todos.items.length} todos</p>
