<!--
	Honeycrisp online (the online variant): the notes and folders in the
	person's repository, through the repository the signed-in layout set.
	Every edit is a commit there; nothing is kept in this browser.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import HoneycrispApp from '$lib/components/HoneycrispApp.svelte';
	import type { Honeycrisp } from '$lib/contract.js';
</script>

<HoneycrispApp variant="online" client={fromClient(getRepo<Honeycrisp>())} />
