<script lang="ts">
	/**
	 * Before any folder opens in a browser: the person chooses the Local demo
	 * or their Epicenter account. Nothing opens, signs in, or transfers until
	 * they choose; a reload reopens the remembered choice.
	 */
	import type { AuthState } from '@epicenter/auth';
	import { Alert, AlertDescription } from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Loading } from '@epicenter/ui/loading';
	import FolderGitIcon from '@lucide/svelte/icons/folder-git-2';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import { onDestroy } from 'svelte';
	import { auth } from '#platform/auth';
	import { openTodosFolder } from '#platform/folder';
	import type { StartProps, TodosPlace } from '../platform/types.js';
	import AccountStart from './AccountStart.svelte';
	import { rememberChoice, rememberedChoice, type StartChoice } from './start-choice.js';

	let { resume, onopen }: StartProps = $props();

	const LOCAL_PLACE: TodosPlace = {
		kind: 'local',
		label: 'Local demo',
		detail:
			'Kept in this browser. Sync sends versions to the demo on this computer.',
	};

	// svelte-ignore state_referenced_locally
	let choice = $state<StartChoice | undefined>(resume ? rememberedChoice(localStorage) : undefined);
	// svelte-ignore state_referenced_locally
	if (!resume) rememberChoice(localStorage, undefined);
	let authState = $state.raw<AuthState>(auth?.getState() ?? { status: 'signed-out' });
	let problem = $state<string>();
	let busy = $state(false);
	let email = $state<string>();
	let alive = true;
	onDestroy(() => {
		alive = false;
	});

	$effect(() => auth?.onStateChange((next) => (authState = next)));

	// Who is signed in, for the account card; a read of the profile only.
	$effect(() => {
		const account = authState.account;
		email = undefined;
		if (authState.status !== 'signed-in' || account === undefined) return;
		void account.getProfile().then(({ data }) => {
			if (authState.account === account) email = data?.email;
		});
	});

	async function openLocal() {
		choice = 'local';
		rememberChoice(localStorage, 'local');
		problem = undefined;
		const opened = await openTodosFolder();
		if (!alive) {
			if (opened.data) await opened.data.close().catch(() => {});
			return;
		}
		if (opened.error) {
			choice = undefined;
			problem = `The Local demo could not be opened: ${opened.error.message}`;
			return;
		}
		onopen(opened.data, LOCAL_PLACE);
	}

	function useAccount() {
		problem = undefined;
		rememberChoice(localStorage, 'account');
		choice = 'account';
	}

	/** Leaves the page for Epicenter's sign-in, which returns to `/auth/callback`. */
	async function signIn(reauthenticate = false) {
		if (auth === undefined) return;
		busy = true;
		problem = undefined;
		rememberChoice(localStorage, 'account');
		const { error } = await auth.startSignIn({ reauthenticate });
		if (!alive) return;
		busy = false;
		if (error) problem = error.message;
	}

	async function signOut() {
		if (auth === undefined) return;
		busy = true;
		await auth.signOut();
		if (!alive) return;
		busy = false;
	}

	function back() {
		rememberChoice(localStorage, undefined);
		choice = undefined;
	}

	// A remembered Local demo reopens at once; the person chose it before.
	// svelte-ignore state_referenced_locally
	if (choice === 'local') void openLocal();
</script>

{#if choice === 'local'}
	<Loading class="h-dvh" label="Opening the Local demo…" />
{:else if choice === 'account' && authState.status === 'signed-in'}
	{#key authState.account}
		<AccountStart account={authState.account} {onopen} onback={back} />
	{/key}
{:else}
	<main class="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-6 px-4 py-10">
		<div class="space-y-1">
			<h1 class="text-xl font-semibold">Where should Todos keep your list?</h1>
			<p class="text-sm text-muted-foreground">Choose where to keep your todos and sync them.</p>
		</div>

		{#if problem}
			<Alert variant="destructive"><AlertDescription>{problem}</AlertDescription></Alert>
		{/if}

		<div class="grid gap-4 md:grid-cols-2">
			<Card.Root data-testid="start-local">
				<Card.Header>
					<Card.Title class="flex items-center gap-2"><HardDriveIcon class="size-4" /> Local demo</Card.Title>
					<Card.Description>
						Todos stay in this browser. Sync sends them to the demo on this computer. No account is needed.
					</Card.Description>
				</Card.Header>
				<Card.Footer>
					<Button variant="outline" disabled={busy} onclick={() => void openLocal()}>Use the Local demo</Button>
				</Card.Footer>
			</Card.Root>

			<Card.Root data-testid="start-account">
				<Card.Header>
					<Card.Title class="flex items-center gap-2"><FolderGitIcon class="size-4" /> Your Epicenter account</Card.Title>
					<Card.Description>
						Choose a private GitHub repository once. Every browser signed in to your account can download
						the same todos, and Sync keeps them together.
					</Card.Description>
				</Card.Header>
				<Card.Content class="text-sm text-muted-foreground">
					{#if auth === undefined}
						Sign-in is not available in this build.
					{:else if authState.status === 'signed-in'}
						Signed in{email ? ` as ${email}` : ''}.
					{:else if authState.status === 'reauth-required'}
						Your sign-in expired. Sign in again to continue.
					{:else}
						Not signed in.
					{/if}
				</Card.Content>
				<Card.Footer class="flex flex-wrap gap-2">
					{#if auth !== undefined}
						{#if authState.status === 'signed-in'}
							<Button disabled={busy} onclick={useAccount}>Continue with your account</Button>
							<Button variant="ghost" disabled={busy} onclick={() => void signOut()}>Sign out</Button>
						{:else if authState.status === 'reauth-required'}
							<Button disabled={busy} onclick={() => void signIn(true)}>Sign in again</Button>
							<Button variant="ghost" disabled={busy} onclick={() => void signOut()}>Sign out</Button>
						{:else}
							<Button disabled={busy} onclick={() => void signIn()}>Sign in</Button>
						{/if}
					{/if}
				</Card.Footer>
			</Card.Root>
		</div>
	</main>
{/if}
