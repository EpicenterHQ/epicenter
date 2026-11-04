<script lang="ts">
	import { toast } from '@epicenter/ui/sonner';
	import Shown from '../Shown.svelte';
	import { openCount } from './count.svelte.js';
	import WorldReader from './WorldReader.svelte';
	import { getWorld } from './world.js';

	const { todos } = getWorld();
	const open = openCount();
	let later = $state(false);
	let handlerRead = $state('');
</script>

<Shown option="c" {todos} />
<p data-testid="helper">helper: {open.current} open</p>
<button onclick={() => (later = true)}>Show later child</button>
<button
	onclick={() => {
		try {
			handlerRead = `handler read ${getWorld().todos.items.length} todos`;
		} catch (error) {
			handlerRead = `handler read threw: ${(error as Error).message}`;
		}
	}}>Read in handler</button
>
<button onclick={() => toast.custom(WorldReader, { componentProps: { where: 'toast' } })}
	>Toast reader</button
>
<p data-testid="handler">{handlerRead}</p>
{#if later}<WorldReader where="later child" />{/if}
