<!--
	The signed-in boundary: the repository for everything under it
	(`getRepo`, read by "Synced"), and, for the account's own repository,
	the uploader that moves every recording on this device into it
	(decisions 12 and 76).
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { openRemote, startUploading } from '@epicenter/folder/remote';
	import { setRepo } from '@epicenter/svelte/repo';
	import { onDestroy, type Snippet } from 'svelte';
	import { recorder } from './contract.ts';
	import { device } from './lib/device.ts';

	// One account for this component's life: `{#key}` above makes a new one
	// for a new account, and sign-out or replacement retires this repository.
	const { account, children }: { account: Account; children: Snippet } = $props();

	// `?repository=<owner>/recorder-demo` opens a repository its owner shared
	// with this account; this device's recordings upload only to its own,
	// so they stay under "On this device" while it is open.
	const shared = new URLSearchParams(location.search).get('repository') as
		| `${string}/${string}`
		| null;
	// svelte-ignore state_referenced_locally
	const repo = setRepo(
		openRemote(recorder, shared ? { account, repository: shared } : { account }),
	);
	// Each view follows its own client: an uploaded recording leaves this
	// device's and appears in the repository's.
	const uploader = shared ? null : startUploading(device, repo);
	onDestroy(() => uploader?.[Symbol.dispose]());
</script>

{@render children()}
