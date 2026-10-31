<!--
	Capture over its one store, which the variant's root opened: the person's
	`capture` repository on the web, where every edit is a commit and nothing
	is kept in the browser, or the desktop window's folder.
-->
<script lang="ts">
	import { store } from '#platform/root';
	import CaptureApp from '$lib/components/CaptureApp.svelte';

	const { captures } = store();
</script>

<CaptureApp list={captures} />
