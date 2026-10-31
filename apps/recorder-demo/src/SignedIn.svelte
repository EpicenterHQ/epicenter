<!--
	The online variant's signed-in root, for one account: it opens the
	repository (`openRemote`), sets it for everything under it (`setRepo`),
	and gives it to the recorder. The parent's `{#key}` makes a new one for a
	new account; sign-out or replacement retires this repository.
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { openRemote } from '@epicenter/folder/remote';
	import { setRepo } from '@epicenter/svelte/repo';
	import Recorder from './Recorder.svelte';
	import { recorder } from './contract.ts';

	const { account }: { account: Account } = $props();

	// `?repository=<owner>/recorder-demo` opens a repository its owner shared
	// with this account instead of the account's own.
	const shared = new URLSearchParams(location.search).get('repository') as
		| `${string}/${string}`
		| null;
	// svelte-ignore state_referenced_locally
	const repo = setRepo(
		openRemote(recorder, shared ? { account, repository: shared } : { account }),
	);
</script>

<p class="meta">
	Recorded straight into {shared ? `the repository ${shared}` : 'your Epicenter repository'};
	nothing is kept in this browser.
</p>
<Recorder client={repo} where={shared ? `in ${shared}` : "in your repository"} />
