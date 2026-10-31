<!--
	The desktop variant's root: Todos over the folder the shell bound to this
	window (`$lib/device.ts`). Epicenter syncs that folder; the page never
	signs in.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { device } from '$lib/device.js';
	import TodosApp from './TodosApp.svelte';
</script>

<TodosApp variant="desktop" todos={fromClient(device).todos} />
