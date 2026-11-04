<script lang="ts">
	import { setWorld } from '$lib/proto/c/world.js';
	import { openWorld } from '$lib/proto/open.js';

	const world = await openWorld('cn2');
	setWorld(world);
</script>

<p>set after await: {world.todos.loading ? 'listing' : 'listed'}</p>
