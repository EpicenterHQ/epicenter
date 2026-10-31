<!--
	"On this device": the todos in this browser's files (or the desktop
	window's folder), signed in or not, online or not (decision 76). Signed
	in, the uploader moves each one to the repository, where the "Synced"
	page shows it.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import TodosApp from '$lib/components/TodosApp.svelte';
	import { device } from '$lib/device.js';
</script>

<TodosApp view="device" todos={fromClient(device).todos} />
