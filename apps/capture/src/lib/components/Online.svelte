<!--
	Capture's store: the person's `capture` repository, for one account, its
	captures set for everything under it (`setCaptureList`). The parent's
	`{#key}` makes a new one for a new account; sign-out or replacement
	retires this one.
-->
<script lang="ts">
	import type { Account } from '@epicenter/account';
	import { capture } from '@epicenter/capture';
	import { APPS } from '@epicenter/constants/apps';
	import { openRemote } from '@epicenter/folder/remote';
	import { fromClient } from '@epicenter/svelte/client';
	import type { Snippet } from 'svelte';
	import { setCaptureList } from '../captures.svelte.js';

	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	setCaptureList(fromClient(openRemote(capture, { account, site: APPS.CAPTURE.url })).captures);
</script>

{@render children()}
