<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	let { children } = $props();
</script>

<!-- Some unrelated feature reruns every load: does the world reopen? -->
<button onclick={() => void invalidateAll()}>Unrelated invalidateAll</button>
{@render children()}
