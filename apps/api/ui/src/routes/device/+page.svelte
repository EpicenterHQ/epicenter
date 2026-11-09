<!--
	The device page (ADR-0549). The `epicenter` CLI shows a code and this
	address. A code goes to `/auth/oauth2/authorize?user_code=<code>`, where the
	authorization server signs the person in and shows the consent page, which
	approves or denies the code with the folders it may reach. The server then
	returns here with `status`, or with `error` for a code it could not use.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import EpicenterMark from '$lib/auth/EpicenterMark.svelte';
	import { deviceAuthorizeUrl } from '$lib/auth/oauth-request';

	const params = new URLSearchParams(window.location.search);
	const userCode = params.get('user_code');
	const status = params.get('status');
	const error = params.get('error');
	const problem =
		error === null
			? null
			: error === 'expired_token'
				? 'That code expired. Start again from your terminal.'
				: 'That code is not valid or was already used. Check it, or start again from your terminal.';
	// A code nobody has answered yet goes straight to the authorization server.
	const forwarding = userCode !== null && status === null && error === null;
	if (forwarding) window.location.replace(deviceAuthorizeUrl(userCode));

	let typedCode = $state(problem ? (userCode ?? '') : '');

	function openCode(event: SubmitEvent) {
		event.preventDefault();
		const code = typedCode.trim();
		if (code) window.location.assign(deviceAuthorizeUrl(code));
	}
</script>

<svelte:head>
	<title>Approve a device: Epicenter</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="flex min-h-dvh items-center justify-center p-6">
	<Card.Root class="w-full max-w-sm gap-5">
		<div class="flex justify-center">
			<EpicenterMark class="size-12 rounded-xl" />
		</div>
		<Card.Header class="justify-items-center text-center">
			<Card.Title>
				<h1 class="text-xl font-semibold tracking-tight">Approve a device</h1>
			</Card.Title>
			<Card.Description>Only approve a code you just started.</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if forwarding}
				<Spinner class="mx-auto size-5" />
			{:else if status === 'approved'}
				<p class="text-center text-sm">Approved. You can go back to your terminal.</p>
			{:else if status === 'denied'}
				<p class="text-center text-sm">Denied. Nothing was signed in.</p>
			{:else}
				<form class="flex flex-col gap-3" onsubmit={openCode}>
					<Input
						bind:value={typedCode}
						placeholder="Code from your terminal"
						autocomplete="off"
						autocapitalize="characters"
						spellcheck={false}
					/>
					<Button type="submit" disabled={!typedCode.trim()}>Continue</Button>
				</form>
			{/if}
			{#if problem}
				<Alert.Root variant="destructive">
					<Alert.Description>{problem}</Alert.Description>
				</Alert.Root>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
