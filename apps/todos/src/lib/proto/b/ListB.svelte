<script lang="ts">
	import { page } from '$app/state';
	import Shown from '../Shown.svelte';
	import type { World } from '../open.js';

	// Any component below the layout reads the load's data from page state.
	const todos = $derived((page.data.world as World).todos);
</script>

<Shown option="b" {todos} />
