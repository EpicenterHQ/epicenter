<!--
	Honeycrisp on this browser (the local variant): the notes and folders in
	this browser's files (OPFS), for this page's whole life. It needs no
	account and works offline; nothing here ever uploads (ADR-0700).
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import HoneycrispApp from '$lib/components/HoneycrispApp.svelte';
	import { device } from '$lib/device.js';
</script>

<HoneycrispApp variant="local" client={fromClient(device)} />
