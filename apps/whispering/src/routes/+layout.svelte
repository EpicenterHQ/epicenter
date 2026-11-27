<!--
	What every window shares: the stylesheet. The main window's frame is
	`(app)/+layout.svelte`; the pill's window (`pill/`) has none.
-->
<script lang="ts">
	import '@epicenter/ui/app.css';

	let { children } = $props();
</script>

{@render children()}
