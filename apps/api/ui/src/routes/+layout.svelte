<script lang="ts">
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';
	let { children } = $props();
</script>

<Tooltip.Provider>
	<div class="min-h-screen bg-background text-foreground">
		{@render children()}
	</div>
	<Toaster offset={16} closeButton />
	<ModeWatcher defaultMode="dark" track={false} />
</Tooltip.Provider>
