<!--
	Todos on this browser (the local web variant), or, in the desktop window,
	on this computer: the todos in this browser's files or the window's
	folder, for this page's whole life. It needs no account and works
	offline; nothing here ever uploads (ADR-0700).
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import TodosApp from '$lib/components/TodosApp.svelte';
	import { device } from '$lib/device.js';
</script>

<TodosApp variant="local" todos={fromClient(device).todos} />
