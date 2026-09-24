<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '@epicenter/ui/button';
</script>

<div class="flex h-dvh flex-col items-center justify-center gap-4">
	<p>This application has stopped. Unsaved work may have been discarded.</p>
	<Button onclick={() => location.replace(resolve('/'))}>Reopen Whispering</Button>
</div>
