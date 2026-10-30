<!--
	One open repository, for as long as the person stays in it: the handle
	opens when this mounts, its status is the repository gate around every
	page of it, and it closes when the person leaves for another repository
	or another page. Moving between its apps keeps it open.
-->
<script lang="ts">
	import RepositoryGate from '@epicenter/svelte/repository/gate';
	import { goto } from '$app/navigation';
	import { onDestroy, type Snippet } from 'svelte';
	import type { Manifest } from './device.svelte.js';
	import { closeRepository, openRepository, setOpenRepository } from './open.svelte.js';

	let { manifest, children }: { manifest: Manifest; children: Snippet } = $props();

	// The copy stays fixed until this unmounts: a new address mounts a new one.
	// svelte-ignore state_referenced_locally
	const open = setOpenRepository(openRepository(manifest));
	onDestroy(() => void closeRepository(open));
</script>

<RepositoryGate repo={open.repo} name={open.manifest.name} onLeave={() => void goto('/me')}>
	{@render children()}
</RepositoryGate>
