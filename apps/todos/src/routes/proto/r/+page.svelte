<script lang="ts">
	import { getApp } from '$lib/proto/r/app.js';

	const { todos, label } = getApp();
</script>

<p data-testid="ready">option r: {todos.loading ? 'listing' : label(todos.items.length)}</p>
