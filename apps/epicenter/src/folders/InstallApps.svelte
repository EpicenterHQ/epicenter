<script lang="ts">
	/**
	 * Installing an app from a folder in a Git repository (ADR-0552).
	 *
	 * "Install from a repository…" takes a Git URL or an absolute path, lists
	 * the apps the `epicenter` CLI finds in it (`epicenter app list
	 * --repository`), each with the folder it is in, and installs the one
	 * chosen (`epicenter app install`), saying each step it reports. Installing clones and builds
	 * nothing; the caller shows the approval, as for any install.
	 */
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import {
		type InstalledApp,
		installApp,
		listRepositoryApps,
		type RepositoryApp,
	} from './app-commands.ts';

	let {
		oninstalled,
	}: {
		/** Called with the app just cloned, which waits for approval. */
		oninstalled: (app: InstalledApp) => void | Promise<void>;
	} = $props();

	/** The URL or path typed in, when the form is shown. */
	let source = $state<string | undefined>(undefined);
	/** The apps found at `source`, once listed. */
	let found = $state<RepositoryApp[] | undefined>(undefined);
	/** What the shell is doing, said while it does it. */
	let doing = $state<string | undefined>(undefined);
	let problem = $state<string | undefined>(undefined);

	async function list() {
		const typed = source?.trim();
		if (!typed) return;
		doing = 'Looking for apps…';
		problem = undefined;
		found = undefined;
		try {
			const { data, error } = await listRepositoryApps(typed);
			if (error !== null) problem = error;
			else if (data.length === 0)
				problem = 'This repository has no folder with an epicenter.app.json.';
			else found = data;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			doing = undefined;
		}
	}

	async function install(from: string, folder: string, title: string) {
		doing = `Cloning ${title}…`;
		problem = undefined;
		try {
			const { data, error } = await installApp(
				from,
				folder,
				(message) => (doing = message),
			);
			if (error !== null) {
				problem = error;
				return;
			}
			source = undefined;
			found = undefined;
			await oninstalled(data);
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			doing = undefined;
		}
	}
</script>

{#if problem !== undefined}
	<Alert.Root variant="destructive" class="mb-2">
		<Alert.Description>{problem}</Alert.Description>
	</Alert.Root>
{/if}
{#if doing !== undefined}
	<p class="px-1 py-1.5 text-sm text-muted-foreground">{doing}</p>
{:else if source === undefined}
	<div class="flex flex-col items-start gap-1">
		<Button variant="ghost" size="sm" onclick={() => (source = '')}>
			Install from a repository…
		</Button>
	</div>
{:else}
	<form
		class="flex flex-col gap-2"
		onsubmit={(event) => {
			event.preventDefault();
			void list();
		}}
	>
		<Input
			bind:value={source}
			oninput={() => (found = undefined)}
			placeholder="https://github.com/you/repository.git or a folder path"
			aria-label="Git URL or folder path"
		/>
		{#if found !== undefined}
			<ul class="flex flex-col gap-0.5" aria-label="Apps in this repository">
				{#each found as app (app.folder)}
					<li class="flex items-center gap-1">
						<span class="min-w-0 flex-1 truncate px-1 text-sm">
							{app.title || app.folder || 'Repository root'}
							<span class="block truncate text-xs text-muted-foreground">
								{app.problem ?? (app.folder || 'Repository root')}
							</span>
						</span>
						{#if app.installed}
							<span class="text-xs text-muted-foreground">Installed</span>
						{:else if app.problem === null}
							<Button
								variant="ghost"
								size="xs"
								onclick={() => void install(source!.trim(), app.folder, app.title)}
							>
								Install
							</Button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<div class="flex gap-2">
			{#if found === undefined}
				<Button type="submit" size="sm" disabled={!source.trim()}>
					Find apps
				</Button>
			{/if}
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onclick={() => {
					source = undefined;
					found = undefined;
					problem = undefined;
				}}
			>
				Cancel
			</Button>
		</div>
	</form>
{/if}
