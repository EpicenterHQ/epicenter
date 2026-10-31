<!--
	Capture over its one store, which the variant's root set: the person's
	`capture` repository on the web, where every edit is a commit and nothing
	is kept in the browser, or the desktop window's folder.
-->
<script lang="ts">
	import type { Capture } from '@epicenter/capture';
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import CaptureApp from '$lib/components/CaptureApp.svelte';
</script>

<CaptureApp list={fromClient(getRepo<Capture>()).captures} />
