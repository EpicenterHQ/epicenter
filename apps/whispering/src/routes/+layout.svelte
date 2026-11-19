<script lang="ts">
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import '@epicenter/ui/app.css';

	let { children } = $props();
</script>

<Tooltip.Provider>
	{@render children()}
</Tooltip.Provider>

<Toaster offset={16} closeButton />
