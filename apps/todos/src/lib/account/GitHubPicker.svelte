<script lang="ts">
	/**
	 * Connect, in a browser: choose the private GitHub repository the todos
	 * sync with. The person signs in to Epicenter, connects GitHub once, and
	 * picks a repository; the choice is only its clone URL, which the folder
	 * keeps in its own Git configuration. Listing repositories is a read;
	 * nothing is sent until the folder connects.
	 */
	import type { AuthState } from '@epicenter/auth';
	import { Alert, AlertDescription } from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { onDestroy } from 'svelte';
	import { auth } from '#platform/auth';
	import type { ConnectPickerProps } from '../platform/types.js';
	import {
		type ConnectorError,
		createConnector,
		GITHUB_APP_URL,
		githubRepository,
		type Repository,
	} from './connector.js';
	import { startGitHubConnect, syncCallback, takeConnected } from './github-connect.js';

	let { busy, onchoose }: ConnectPickerProps = $props();

	let authState = $state.raw<AuthState>(auth?.getState() ?? { status: 'signed-out' });
	$effect(() => auth?.onStateChange((next) => (authState = next)));
	/** GitHub was connected in this tab just now, as this login. */
	const connectedAs = takeConnected(sessionStorage);
	let problem = $state<string>();
	let connecting = $state(false);
	let repositories = $state.raw<Repository[]>();
	let listing = $state(false);
	let listError = $state.raw<ConnectorError>();
	let alive = true;
	onDestroy(() => {
		alive = false;
	});

	const account = $derived(authState.status === 'signed-in' ? authState.account : undefined);
	const needsGitHub = $derived(
		listError?.name === 'Refused' && listError.code === 'github_authorization_required',
	);

	/** Leaves the page for Epicenter's sign-in, which returns to `/auth/callback`. */
	async function signIn(reauthenticate = false) {
		if (auth === undefined) return;
		problem = undefined;
		const { error } = await auth.startSignIn({ reauthenticate });
		if (alive && error) problem = error.message;
	}

	/** Leave for GitHub to connect it; GitHub returns to `/sync`. */
	async function connectGitHub() {
		if (account === undefined) return;
		connecting = true;
		problem = undefined;
		const { data: authorizeUrl, error } = await startGitHubConnect({
			account,
			redirectUri: syncCallback(location.origin),
			storage: sessionStorage,
			isCurrent: () => alive,
		});
		if (!alive) return;
		if (error) {
			connecting = false;
			problem = error.message;
			return;
		}
		location.assign(authorizeUrl);
	}

	/** The repositories the person can choose. A read. */
	async function listRepositories() {
		if (account === undefined) return;
		listing = true;
		listError = undefined;
		const { data, error } = await createConnector(account).repositories();
		if (!alive) return;
		listing = false;
		if (error) listError = error;
		else repositories = data;
	}

	// GitHub was connected just now: show what it reaches without asking again.
	$effect(() => {
		if (connectedAs !== undefined && account !== undefined && repositories === undefined)
			void listRepositories();
	});
</script>

<div class="space-y-3" data-testid="github-picker">
	{#if problem}
		<Alert variant="destructive"><AlertDescription>{problem}</AlertDescription></Alert>
	{/if}
	{#if auth === undefined}
		<p class="text-sm text-muted-foreground">Sign-in is not available in this build.</p>
	{:else if authState.status === 'reauth-required'}
		<p class="text-sm text-muted-foreground">Your sign-in expired. Sign in again to choose a repository.</p>
		<Button onclick={() => void signIn(true)}>Sign in again</Button>
	{:else if account === undefined}
		<p class="text-sm text-muted-foreground">Sign in to Epicenter, then choose a private GitHub repository.</p>
		<Button onclick={() => void signIn()}>Sign in</Button>
	{:else}
		{#if connectedAs}
			<p class="text-sm" data-testid="github-connected">GitHub is connected as <strong>{connectedAs}</strong>.</p>
		{/if}
		{#if repositories === undefined}
			<div class="flex flex-wrap gap-2">
				<Button disabled={listing} onclick={() => void listRepositories()}>
					{#if listing}<Spinner class="size-3.5" />{/if}
					Show my repositories
				</Button>
				<Button variant="outline" disabled={connecting} onclick={() => void connectGitHub()}>
					{#if connecting}<Spinner class="size-3.5" />{/if}
					{connectedAs ? 'Connect another GitHub account' : 'Connect GitHub'}
				</Button>
			</div>
		{:else if repositories.length === 0}
			<Alert>
				<AlertDescription>
					No private repository is available to Epicenter for this GitHub account. Install the
					<a class="underline" href={GITHUB_APP_URL} target="_blank" rel="noreferrer">Epicenter Folder Sync</a>
					app on a private repository, then show your repositories again.
				</AlertDescription>
			</Alert>
			<Button variant="outline" disabled={listing} onclick={() => void listRepositories()}>Show my repositories again</Button>
		{:else}
			<ul class="max-h-72 divide-y overflow-y-auto rounded-lg border" data-testid="repositories">
				{#each repositories as repository (repository.id)}
					{@const usable = repository.push && githubRepository(repository.cloneUrl) !== undefined}
					<li class="flex items-center gap-3 px-3 py-2">
						<div class="min-w-0 flex-1">
							<div class="truncate font-mono text-sm">{repository.fullName}</div>
							<div class="text-xs text-muted-foreground">
								{repository.push ? 'Private' : 'Read-only for you, so Todos cannot sync with it'}
							</div>
						</div>
						<Button size="sm" variant="outline" disabled={!usable || busy} onclick={() => onchoose(repository.cloneUrl)}>
							Use this repository
						</Button>
					</li>
				{/each}
			</ul>
		{/if}
		{#if listError}
			<Alert variant={needsGitHub ? 'warning' : 'destructive'}>
				<AlertDescription>
					{listError.message}
					{#if listError.name === 'Refused' && listError.installUrl}
						<a class="underline" href={listError.installUrl} target="_blank" rel="noreferrer">Install the app</a>.
					{/if}
				</AlertDescription>
			</Alert>
			{#if needsGitHub}
				<Button disabled={connecting} onclick={() => void connectGitHub()}>Connect GitHub</Button>
			{/if}
		{/if}
	{/if}
	{#if import.meta.env.DEV}
		<!-- The loopback remote `bun dev:todos` serves, reached through the dev proxy. -->
		<div class="border-t pt-3">
			<Button
				variant="ghost"
				size="sm"
				disabled={busy}
				data-testid="demo-remote"
				onclick={() => onchoose(`${location.origin}/git/todos.git`)}
			>
				Use the demo remote on this computer
			</Button>
		</div>
	{/if}
</div>
