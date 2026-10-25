<!--
	Test helper: renders one component inside what the page layout gives every
	view, the tooltip provider, so a mounted test renders it as the page does.
	`props` is read when the component reads it: a getter on it is a prop a
	test can change.
-->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Component } from 'svelte';

	let {
		component: Shown,
		props,
	}: {
		component: Component<Record<string, unknown>>;
		props: Record<string, unknown>;
	} = $props();
</script>

<Tooltip.Provider>
	<Shown {...props} />
</Tooltip.Provider>
