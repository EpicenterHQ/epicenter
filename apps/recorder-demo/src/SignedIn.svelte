<!--
	The signed-in boundary: the repository for everything under it
	(`getRepo`), and, for the account's own repository, the uploader that
	moves this browser's captures into it (decision 12).
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
	// with this account; this browser's captures upload only to its own.
	const shared = new URLSearchParams(location.search).get('repository') as
		| `${string}/${string}`
		| null;
	// svelte-ignore state_referenced_locally
	const repo = setRepo(
		openRemote(recorder, shared ? { account, repository: shared } : { account }),
	);
	// The uploader's writes reach both sides' listeners, so the list follows it.
	const uploader = shared ? null : startUploading(device, repo);
	onDestroy(() => uploader?.[Symbol.dispose]());
</script>

{@render children()}
