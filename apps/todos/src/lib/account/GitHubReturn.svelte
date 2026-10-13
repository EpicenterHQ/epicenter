<script lang="ts">
	/**
	 * `/sync`: where GitHub returns, through the connector, after the person
	 * connects it. The attempt this tab began is completed once, for the
	 * account that began it; then Todos returns to its start page, which reads
	 * the account again. Nothing is paired or transferred here.
	 */
	import { Alert, AlertDescription } from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy } from 'svelte';
	import { auth } from '#platform/auth';
	import type { GitHubReturnProps } from '../platform/types.js';
	import { finishGitHubConnect, isGitHubReturn } from './github-connect.js';
	import { noteConnected } from './start-choice.js';

	let { url, onfinished }: GitHubReturnProps = $props();

	let problem = $state<{ message: string; installUrl?: string }>();
	let alive = true;
	onDestroy(() => {
		alive = false;
	});

	async function finish() {
		if (!isGitHubReturn(url)) return onfinished();
		const state = auth?.getState();
		if (state?.status === 'reauth-required') {
			problem = { message: 'Your sign-in expired. Sign in again, then connect GitHub.' };
			return;
		}
		try {
			const { data, error } = await finishGitHubConnect({
				url,
				account: state?.account,
				storage: sessionStorage,
			});
			if (!alive) return;
			if (error) {
				problem = {
					message: error.message,
					installUrl: 'installUrl' in error ? error.installUrl : undefined,
				};
				return;
			}
			noteConnected(sessionStorage, data.login);
			onfinished();
		} catch {
			if (alive) problem = { message: 'GitHub could not finish connecting. Try again.' };
		}
	}

	void finish();
</script>

{#if problem}
	<main class="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4">
		<h1 class="text-xl font-semibold">GitHub was not connected</h1>
		<Alert variant="destructive">
			<AlertDescription>
				{problem.message}
				{#if problem.installUrl}
					<a class="underline" href={problem.installUrl} target="_blank" rel="noreferrer">Install the app</a>.
				{/if}
			</AlertDescription>
		</Alert>
		<div><Button onclick={onfinished}>Back to Todos</Button></div>
	</main>
{:else}
	<Loading class="h-dvh" label="Connecting GitHub…" />
{/if}
