<script lang="ts">
	import DevAccessibilityToggle from '$lib/components/DevAccessibilityToggle.svelte';
	import MacosAccessibilityGuideDialog from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import MoreDetailsDialog from '$lib/components/MoreDetailsDialog.svelte';
	import RecipePicker from '$lib/components/RecipePicker.svelte';
</script>

<!--
	App-wide singleton dialogs. Each is driven by a module-level store, so this
	component mounts them once for the whole app. It lives at the session root,
	outside the responsive nav branch, so resizing across the breakpoint never
	tears a dialog down mid-interaction.

	`ConfirmationDialog` is not here: it is in the root layout, because the
	destructive exit confirms through it and then closes the session this
	component lives under.
-->
<MacosAccessibilityGuideDialog />
<MoreDetailsDialog />
<RecipePicker />

{#if import.meta.env.DEV}
	<DevAccessibilityToggle />
{/if}
