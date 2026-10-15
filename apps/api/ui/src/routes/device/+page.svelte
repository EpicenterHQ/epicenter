<!--
	The device approval page (ADR-0549). The `epicenter` CLI shows a code and
	this address; the person opens it signed in, checks the code, picks the
	folders the device may reach, and approves. Opening the code claims it for
	this account, so nobody else can approve it.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation, createQuery, QueryClient } from '@tanstack/svelte-query';
	import EpicenterMark from '$lib/auth/EpicenterMark.svelte';
	import GrantRequest from '$lib/auth/GrantRequest.svelte';
	import { authClient } from '$lib/auth/client';
	import {
		fetchGrantTargets,
		fetchPublicClient,
		readJson,
		selectGrantTarget,
	} from '$lib/auth/oauth-request';

	const queries = new QueryClient();
	$effect(() => () => queries.clear());
	const userCode = new URLSearchParams(window.location.search).get('user_code');
	let typedCode = $state('');
	let target = $state('');
	let finished = $state<'approved' | 'denied' | null>(null);

	const session = createQuery(
		() => ({
			queryKey: ['device-session'],
			queryFn: async () => {
				const { data, error } = await authClient.getSession({
					query: { disableCookieCache: true },
				});
				if (error) throw new Error(error.message ?? 'Could not read sign-in.');
				return data;
			},
			retry: false,
		}),
		() => queries,
	);

	const request = createQuery(
		() => ({
			queryKey: ['device-request', userCode],
			enabled: Boolean(userCode && session.data?.user),
			queryFn: async () => {
				const device = await readJson<{
					status: string;
					client_id?: string;
					scope?: string;
				}>(
					await fetch(`/auth/device?user_code=${encodeURIComponent(userCode ?? '')}`, {
						credentials: 'include',
					}),
					'That code is not valid. Start again from your terminal.',
				);
				if (device.status !== 'pending')
					throw new Error('That code was already used. Start again from your terminal.');
				if (!device.client_id)
					throw new Error('Someone else already opened that code.');
				const [client, options] = await Promise.all([
					fetchPublicClient(device.client_id),
					fetchGrantTargets(),
				]);
				return {
					client,
					options,
					scopes: (device.scope ?? '').split(' ').filter(Boolean),
				};
			},
			retry: false,
		}),
		() => queries,
	);

	const decide = createMutation(
		() => ({
			mutationFn: async (approve: boolean) => {
				if (!userCode) return;
				if (approve) {
					if (!target) throw new Error('Choose which folders it can reach.');
					await selectGrantTarget(target, { userCode });
				}
				await readJson(
					await fetch(`/auth/device/${approve ? 'approve' : 'deny'}`, {
						method: 'POST',
						credentials: 'include',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ userCode }),
					}),
					'Could not answer the request.',
				);
				finished = approve ? 'approved' : 'denied';
			},
		}),
		() => queries,
	);

	function openCode(event: SubmitEvent) {
		event.preventDefault();
		const code = typedCode.trim();
		if (code) window.location.assign(`/device?user_code=${encodeURIComponent(code)}`);
	}

	const signInUrl = $derived(
		`/sign-in?${new URLSearchParams({ return: `/device${window.location.search}` })}`,
	);
	const error = $derived(decide.error ?? request.error ?? session.error);
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
			{#if session.isPending}
				<Spinner class="mx-auto size-5" />
			{:else if !session.data?.user}
				<Button href={signInUrl}>Sign in to continue</Button>
			{:else if finished === 'approved'}
				<p class="text-center text-sm">Approved. You can go back to your terminal.</p>
			{:else if finished === 'denied'}
				<p class="text-center text-sm">Denied. Nothing was signed in.</p>
			{:else if !userCode}
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
			{:else if request.isPending}
				<Spinner class="mx-auto size-5" />
			{:else if request.data}
				<p class="text-center font-mono text-lg tracking-widest">{userCode}</p>
				<p class="text-sm">
					{request.data.client.client_name ?? request.data.client.client_id} on
					another device wants to:
				</p>
				<GrantRequest
					scopes={request.data.scopes}
					options={request.data.options}
					bind:target
					disabled={decide.isPending}
				/>
				<Button
					disabled={decide.isPending || !target}
					onclick={() => decide.mutate(true)}
				>
					{#if decide.isPending}<Spinner class="size-4" />{/if}
					Approve
				</Button>
				<Button
					variant="outline"
					disabled={decide.isPending}
					onclick={() => decide.mutate(false)}
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
