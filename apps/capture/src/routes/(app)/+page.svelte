<!--
	"On this device": the captures in this browser's files, signed in or not,
	online or not (decision 76). Signed in, the uploader moves each one to
	the repository, where the "Synced" page shows it.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import CaptureApp from '$lib/components/CaptureApp.svelte';
	import { device } from '$lib/device.js';
</script>

<CaptureApp view="device" list={fromClient(device).captures} />
