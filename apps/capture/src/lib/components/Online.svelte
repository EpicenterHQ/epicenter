<!--
	Capture's store: the person's `capture` repository, for one account,
	read as a folder through `reactive` once here, its captures set for
	everything under it (`setCaptureList`). While a write to it is out,
	leaving the page asks first. The parent's `{#key}` makes a new one for a
	new account; sign-out or replacement retires this one.
-->
<script lang="ts">
	import type { Account } from '@epicenter/account';
	import { capture } from '../model/index.js';
	import { APPS } from '@epicenter/definition/site';
	import { folderOf } from '@epicenter/folder/core';
	import { openRemote } from '@epicenter/folder/remote';
	import LeaveGuard from '@epicenter/svelte/leave-guard';
	import { reactive } from '@epicenter/svelte/reactive';
	import type { Snippet } from 'svelte';
	import { setCaptureList } from '../captures.svelte.js';

	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	const folder = reactive(folderOf(openRemote(capture, { account, site: APPS.CAPTURE.url })));
	setCaptureList(folder.captures);
</script>

{@render children()}

<LeaveGuard {folder} />
