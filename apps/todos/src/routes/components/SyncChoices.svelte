<script lang="ts">
	/**
	 * Where the todos sync, chosen in Connect: Epicenter, under a name in the
	 * signed-in account's personal namespace, or any other Git server by its
	 * URL. The choice is only the remote URL, which the folder keeps in its
	 * own Git configuration. Epicenter creates the repository on the first
	 * sync. Another server uses the desktop's own Git credentials; the page
	 * holds no token for it.
	 */
	import type { AuthState } from '@epicenter/auth';
	import { isRepositoryName } from '@epicenter/constants/repositories';
	import { Alert, AlertDescription } from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import { onDestroy } from 'svelte';
	import { auth } from '#platform/auth';
	import { requestConnect } from '$lib/connect-request.js';
	import { connectEpicenter, proposedName } from '$lib/remote.js';

	let { busy, onchoose }: {
		/** A connect is running; nothing new is chosen until it ends. */
		busy: boolean;
		/** Connect the folder to this remote URL. */
		onchoose: (url: string) => void;
	} = $props();

	let authState = $state.raw<AuthState>(auth?.getState() ?? { status: 'signed-out' });
	$effect(() => auth?.onStateChange((next) => (authState = next)));
	let asking = $state(false);
	let problem = $state<string>();
	let name = $state(proposedName);
	let url = $state('');
	let serverProblem = $state<string>();

	/** Whether `url` carries a password, which would land in Git's configuration. */
	function carriesPassword(url: string) {
		try {
			return new URL(url).password !== '';
		} catch {
			return false;
		}
	}
	let alive = true;
	onDestroy(() => {
		alive = false;
	});

	/** Leaves the page for Epicenter's sign-in, which comes back to Connect. */
	async function signIn(reauthenticate = false) {
		if (auth === undefined) return;
		problem = undefined;
		requestConnect();
		const { error } = await auth.startSignIn({ reauthenticate });
		if (alive && error) problem = error.message;
	}

	/** Resolve the remote for `name` in this account's namespace, then connect to it. */
	async function useEpicenter(event: SubmitEvent) {
		event.preventDefault();
		const chosen = name.trim();
		if (!isRepositoryName(chosen)) {
			problem =
				'A name uses lowercase letters, digits, ".", "_", and "-", starts with a letter or digit, and does not end in ".git".';
			return;
		}
		asking = true;
		problem = undefined;
		const { data: remote, error } = await connectEpicenter(chosen);
		if (!alive) return;
		asking = false;
		if (error) {
			problem = error.message;
			return;
		}
		onchoose(remote);
	}

	function useServer(event: SubmitEvent) {
		event.preventDefault();
		const target = url.trim();
		if (!target) return;
		serverProblem = undefined;
		if (carriesPassword(target)) {
			serverProblem =
				'Put no password in the URL: a URL is kept in the folder\'s Git settings, where anyone with the folder can read it. Sign in with your own Git instead.';
			return;
		}
		onchoose(target);
	}
</script>

<div class="space-y-4">
	{#if auth !== undefined}
		<section class="space-y-2" data-testid="sync-epicenter">
			{#if authState.status === 'signed-in'}
				<form class="space-y-2" onsubmit={useEpicenter}>
					<p class="text-sm text-muted-foreground">
						Epicenter keeps a private copy for your account, so every device you sign in on syncs the same todos.
					</p>
					<Input
						aria-label="Name"
						class="font-mono"
						spellcheck={false}
						autocapitalize="off"
						bind:value={name}
						disabled={busy || asking}
						data-testid="epicenter-name"
					/>
					<Button type="submit" disabled={busy || asking || !name.trim()} data-testid="use-epicenter">
						{#if asking}<Spinner class="size-3.5" />{/if}
						Sync with Epicenter
					</Button>
				</form>
			{:else if authState.status === 'reauth-required'}
				<p class="text-sm text-muted-foreground">Your Epicenter sign-in expired. Sign in again to sync with it.</p>
				<Button disabled={busy} onclick={() => void signIn(true)}>Sign in again</Button>
			{:else}
				<p class="text-sm text-muted-foreground">
					Sign in to Epicenter to keep a private copy that every device you sign in on syncs.
				</p>
				<Button disabled={busy} onclick={() => void signIn()} data-testid="sign-in">Sign in to Epicenter</Button>
			{/if}
			{#if problem}
				<Alert variant="destructive">
					<AlertDescription>{problem}</AlertDescription>
				</Alert>
			{/if}
		</section>
	{/if}

	<form class="space-y-2 border-t pt-4" onsubmit={useServer} data-testid="sync-server">
		<p class="text-sm text-muted-foreground">
			Or another Git server, such as <code>https://git.example.com/you/todos.git</code>. The desktop app signs in
			with your own Git.
		</p>
		<Input
			aria-label="Remote URL"
			class="font-mono"
			spellcheck={false}
			autocapitalize="off"
			placeholder="https://git.example.com/you/todos.git"
			bind:value={url}
			disabled={busy}
			data-testid="remote-url"
		/>
		{#if serverProblem}
			<Alert variant="destructive">
				<AlertDescription>{serverProblem}</AlertDescription>
			</Alert>
		{/if}
		<Button type="submit" variant="outline" disabled={busy || !url.trim()}>Connect</Button>
	</form>

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
