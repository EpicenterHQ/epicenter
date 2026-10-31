<!--
	"On this device": the captures in this browser's files, signed in or not,
	online or not (decision 76); in the desktop window, its folder's. Signed in, the uploader moves each one to
	the repository, where the "Synced" page shows it.
-->
<script lang="ts">
	import { device } from '#platform/device';
	import { fromClient } from '@epicenter/svelte/client';
	import CaptureApp from '$lib/components/CaptureApp.svelte';
</script>

<CaptureApp view="device" list={fromClient(device).captures} />
