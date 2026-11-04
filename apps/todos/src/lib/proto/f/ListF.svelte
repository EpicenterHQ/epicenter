<script lang="ts">
	import { toast } from '@epicenter/ui/sonner';
	import Shown from '../Shown.svelte';
	import { world } from './app.js';
	import WorldReaderF from './WorldReaderF.svelte';

	const { todos } = await world;
</script>

<Shown option="f" {todos} />
<button onclick={() => toast.custom(WorldReaderF, { componentProps: { where: 'toast' } })}
	>Toast reader</button
>
