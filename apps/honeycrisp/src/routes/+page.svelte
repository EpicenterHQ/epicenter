<!--
	Honeycrisp over one of this browser's repositories, chosen in the
	repository chooser: kept only on this device, or synced with a server.
-->
<script lang="ts">
	import RepositoryChooser from '@epicenter/svelte/repository/chooser';
	import { honeycrispApp } from '$lib/data.js';
	import HoneycrispApp from './components/HoneycrispApp.svelte';
</script>

<RepositoryChooser app={honeycrispApp} name="Honeycrisp">
	{#snippet children({ repo, manifest, leave })}
		<HoneycrispApp {repo} repository={manifest.name} syncsTo={manifest.url ?? undefined} onLeave={leave} />
	{/snippet}
</RepositoryChooser>
