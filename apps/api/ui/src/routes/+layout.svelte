<script lang="ts">
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';
	let { children } = $props();
</script>

<div class="min-h-screen bg-background text-foreground">
	{@render children()}
</div>
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
