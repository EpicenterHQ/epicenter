<!--
	One capture's page, at the capture's path: `#/captures/<time>.md`. Keyed
	by the path so each capture gets its own view.
-->
<script lang="ts">
	import { page } from '$app/state';
	import CaptureView from '$lib/components/CaptureView.svelte';
</script>

{#key page.params.path}
	<CaptureView path={page.params.path ?? ''} />
{/key}
