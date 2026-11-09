<script lang="ts">
	import { page } from '$app/state';
	import CaptureView from '$lib/components/CaptureView.svelte';
</script>

{#key page.params.id}
	<CaptureView id={page.params.id ?? ''} />
{/key}
