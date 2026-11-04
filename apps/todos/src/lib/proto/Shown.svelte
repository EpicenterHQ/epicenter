<!-- PROTOTYPE. What every option's page shows once its world is open. -->
<script lang="ts">
	import type { World } from './open.js';

	let { option, todos }: { option: string; todos: World['todos'] } = $props();
</script>

<p data-testid="ready">
	option {option}: {todos.loading ? 'listing' : `${todos.items.length} todos`}
</p>
