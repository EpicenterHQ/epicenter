<!--
	The online variant's signed-in root, for one account: it opens the
	repository (`openRemote`), read as a folder through `reactive` once,
	and gives it to the recorder. A shared repository (`?repository=`) is
	why this opens its own instead of `openFolder`, which opens only the
	account's own repository for a site. The parent's `{#key}` makes a new one for a new account;
	sign-out or replacement retires this repository.
-->
<script lang="ts">
	import type { Account } from '@epicenter/account';
	import { folderOf } from '@epicenter/folder/core';
	import { openRemote } from '@epicenter/folder/remote';
	import { reactive } from '@epicenter/svelte/reactive';
	import Recorder from './Recorder.svelte';
	import { recordInPage } from './lib/record.ts';
	import { recorder } from './contract.ts';

	const { account }: { account: Account } = $props();

	// `?repository=<owner>/recorder-demo` opens a repository its owner shared
	// with this account instead of the account's own.
	const shared = new URLSearchParams(location.search).get('repository') as
		| `${string}/${string}`
		| null;
	// svelte-ignore state_referenced_locally
	const folder = reactive(
		folderOf(
			openRemote(recorder, {
				account,
				repository: shared ?? '~/recorder-demo',
			}),
		),
	);
</script>

<p class="meta">
	Recorded straight into {shared ? `the repository ${shared}` : 'your Epicenter repository'};
	nothing is kept in this browser.
</p>
<Recorder {folder} record={recordInPage} where={shared ? `in ${shared}` : "in your repository"} />
