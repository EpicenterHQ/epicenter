<!--
	"On this device": the notes and folders in this browser's files (OPFS),
	signed in or not, online or not (decision 76). Signed in, the uploader
	moves each one to the repository, where the "Synced" page shows it.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import HoneycrispApp from '$lib/components/HoneycrispApp.svelte';
	import { device } from '$lib/device.js';
</script>

<HoneycrispApp view="device" client={fromClient(device)} />
