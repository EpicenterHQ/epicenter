<script lang="ts">
	import { page } from '$app/state';
	import { getApp } from '$lib/proto/s/app.js';
	import { fromClient } from '@epicenter/svelte/client';

	const { folder, models, label } = getApp();
	const { todos } = fromClient(folder.client());
	let chat = $state(models.get('chat')?.model ?? 'none');
	const bug = () => {
		if (page.url.searchParams.has('boom')) throw new Error('page render bug');
		return '';
	};
</script>

<p data-testid="ready">option s: {todos.loading ? 'listing' : label(todos.items.length)}{bug()}</p>
<p data-testid="model">chat model: {chat}</p>
<button
	onclick={() => {
		models.set('chat', { endpoint: 'hosted', model: 'small' });
		chat = models.get('chat')?.model ?? 'none';
	}}>Choose small</button
>
