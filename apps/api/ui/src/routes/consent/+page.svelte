<!--
	The authorization server's consent page (ADR-0549). An app that does not
	skip consent lands here with the authorization request the server signed,
	and so does every device code (`user_code`), which only this answer
	approves. The person picks the folders the grant reaches; the page stages
	that choice, then answers the consent, and the server redirects to the app
	or back to the device page.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation, createQuery, QueryClient } from '@tanstack/svelte-query';
	import EpicenterMark from '$lib/auth/EpicenterMark.svelte';
	import GrantRequest from '$lib/auth/GrantRequest.svelte';
	import {
		fetchGrantTargets,
		fetchPublicClient,
		readJson,
		readOAuthRequest,
		selectGrantTarget,
	} from '$lib/auth/oauth-request';

	const queries = new QueryClient();
	$effect(() => () => queries.clear());
	const request = readOAuthRequest(window.location.search);
	const clientId = request?.clientId ?? null;
	let target = $state('');

	const details = createQuery(
		() => ({
			queryKey: ['consent', clientId],
			enabled: clientId !== null,
			queryFn: async () => {
				if (!clientId) throw new Error('Start from the app that sent you here.');
				const [client, options] = await Promise.all([
					fetchPublicClient(clientId),
					fetchGrantTargets(),
				]);
				return { client, options };
			},
			retry: false,
		}),
		() => queries,
	);

	const answer = createMutation(
		() => ({
			mutationFn: async (accept: boolean) => {
				if (!request || !clientId)
					throw new Error('Start from the app that sent you here.');
				if (accept) {
					if (!target) throw new Error('Choose which folders it can reach.');
					await selectGrantTarget(target, clientId);
				}
				const result = await readJson<{ url?: string }>(
					await fetch('/auth/oauth2/consent', {
						method: 'POST',
						credentials: 'include',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ accept, oauth_query: request.oauthQuery }),
					}),
					'Could not answer the request.',
				);
				if (!result.url) throw new Error('Could not answer the request.');
				window.location.replace(result.url);
			},
		}),
		() => queries,
	);

	const appName = $derived(
		details.data?.client.client_name ?? clientId ?? 'This app',
	);
	const userCode = request?.userCode ?? null;
	const error = $derived(answer.error ?? details.error);
</script>

<svelte:head>
	<title>{userCode ? 'Approve a device' : 'Allow access'}: Epicenter</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="flex min-h-dvh items-center justify-center p-6">
	<Card.Root class="w-full max-w-sm gap-5">
		<div class="flex justify-center">
			<EpicenterMark class="size-12 rounded-xl" />
		</div>
		<Card.Header class="justify-items-center text-center">
			<Card.Title>
				<h1 class="text-xl font-semibold tracking-tight">
					{userCode ? 'Approve a device' : `Allow ${appName}?`}
				</h1>
			</Card.Title>
			<Card.Description>
				{#if userCode}
					Only approve a code you just started.
				{:else}
					{#if details.data?.client.client_uri}
						From {new URL(details.data.client.client_uri).host}.
					{/if}
					It can do this until you remove it from your account.
				{/if}
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if !request || !clientId}
				<p class="text-sm">Start from the app that sent you here.</p>
			{:else if details.isPending}
				<Spinner class="mx-auto size-5" />
			{:else if details.data}
				{#if userCode}
					<p class="text-center font-mono text-lg tracking-widest">{userCode}</p>
					<p class="text-sm">{appName} on another device wants to:</p>
				{/if}
				<GrantRequest
					scopes={request.scopes}
					options={details.data.options}
					bind:target
					disabled={answer.isPending}
				/>
				<Button
					disabled={answer.isPending || !target}
					onclick={() => answer.mutate(true)}
				>
					{#if answer.isPending}<Spinner class="size-4" />{/if}
					{userCode ? 'Approve' : 'Allow'}
				</Button>
				<Button
					variant="outline"
					disabled={answer.isPending}
					onclick={() => answer.mutate(false)}
				>
					Deny
				</Button>
			{/if}
			{#if error}
				<Alert.Root variant="destructive">
					<Alert.Description>{error.message}</Alert.Description>
				</Alert.Root>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
