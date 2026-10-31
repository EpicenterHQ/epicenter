<!--
	Capture's root, which decides the store (decision 78): the variant's
	`Root` (`#platform/root`) sets it for every page under it. The web app's is
	the person's repository behind sign-in; the desktop window's is the folder
	Capture keeps its files in. The sign-in callback is outside this group.
-->
<script lang="ts">
	import { Root } from '#platform/root';

	let { children } = $props();
</script>

<Root>{@render children()}</Root>
