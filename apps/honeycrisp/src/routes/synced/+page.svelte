<!--
	"Synced": the notes and folders in the person's repository, through the
	repository the signed-in boundary set (decision 76). Edits here write to
	the repository; this device's own notes are on the "On this device" page.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import HoneycrispApp from '$lib/components/HoneycrispApp.svelte';
	import type { Honeycrisp } from '$lib/contract.js';
</script>

<HoneycrispApp view="synced" client={fromClient(getRepo<Honeycrisp>())} />
