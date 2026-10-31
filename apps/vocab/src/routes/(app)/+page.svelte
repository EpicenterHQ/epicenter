<!--
	"On this device": the words and chats in this browser's files (OPFS,
	`$lib/device.ts`), with no sign-in in front of them, online or not
	(decisions 10 and 76). Signed in, the uploader moves each one to the
	repository, where the "Synced" page shows it.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { device } from '$lib/device.js';
	import VocabApp from '../components/VocabApp.svelte';
</script>

<VocabApp view="device" vocab={fromClient(device)} />
