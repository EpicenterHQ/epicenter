<!--
	Test fixture: the providers an app root gives the folder UI, a sidebar
	for the file tree and tooltips for icon buttons, around one component.
-->
<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Component } from 'svelte';

	// Each test passes the props its component takes; the pairing is not checked here.
	let { component: Shown, props }: { component: Component<object>; props: object } = $props();
</script>

<Tooltip.Provider>
	<Sidebar.Provider>
		<Shown {...props} />
	</Sidebar.Provider>
</Tooltip.Provider>
