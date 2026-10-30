<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Snippet } from 'svelte';
	import '../app.css';

	let { children }: { children: Snippet } = $props();
</script>

<Tooltip.Provider>
	{@render children()}
</Tooltip.Provider>
