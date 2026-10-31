<!--
	Capture over its one store: the person's `capture` repository, which the
	signed-in layout set. Every edit is a commit there; nothing is kept in
	the browser.
-->
<script lang="ts">
	import type { Capture } from '@epicenter/capture';
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import CaptureApp from '$lib/components/CaptureApp.svelte';
</script>

<CaptureApp list={fromClient(getRepo<Capture>()).captures} />
