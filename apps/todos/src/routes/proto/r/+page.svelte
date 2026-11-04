<script lang="ts">
	import { page } from '$app/state';
	import { getApp } from '$lib/proto/r/app.js';

	const { todos, label } = getApp();
	const bug = () => {
		if (page.url.searchParams.has('boom')) throw new Error('page render bug');
		return '';
	};
</script>

<p data-testid="ready">option r: {todos.loading ? 'listing' : label(todos.items.length)}{bug()}</p>
