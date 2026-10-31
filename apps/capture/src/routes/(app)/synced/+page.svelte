<!--
	"Synced": the captures in the person's `capture` repository, through the
	repository the signed-in boundary set (decision 76). Edits here write to
	the repository; this browser's own captures are on the "On this device"
	page.
-->
<script lang="ts">
	import type { Capture } from '@epicenter/capture';
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import CaptureApp from '$lib/components/CaptureApp.svelte';
</script>

<CaptureApp view="synced" list={fromClient(getRepo<Capture>()).captures} />
