<script lang="ts">
	import { AppBoot } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { authStartup } from '#platform/auth';
	import { onMount, tick } from 'svelte';

	let mounted = $state.raw<{
		application: typeof import('$lib/application.js');
		Shell: typeof import('$lib/components/MailShell.svelte').default;
	}>();
	let shell =
		$state.raw<
			ReturnType<typeof import('$lib/components/MailShell.svelte').default>
		>();
	let error = $state('');
	let showing = $state(true);
	const queryClient = useQueryClient();

	onMount(() => {
		let stopped = false;
		void import('$lib/application.js')
			.then(async (application) => {
				if (stopped) {
					await application.departure.close();
					return;
				}
				application.departure.attachUi({
					async preflight() {
						await shell?.preflight();
					},
					async quiesce() {
						showing = false;
						await tick();
						await queryClient.cancelQueries();
						queryClient.clear();
					},
				});
				try {
					const { default: Shell } =
						await import('$lib/components/MailShell.svelte');
					if (stopped) {
						await application.departure.close();
						return;
					}
					mounted = { application, Shell };
				} catch (cause) {
					await application.departure.close();
					throw cause;
				}
			})
			.catch((cause) => {
				error =
					cause instanceof Error ? cause.message : 'Could not open Local Mail.';
			});
		return () => {
			stopped = true;
		};
	});
</script>

{#if error}
	<p role="alert" class="p-6">{error}</p>
{:else if mounted}
	<AppBoot
		startup={authStartup}
		departure={mounted.application.departure}
		opening={mounted.application.opening}
		appName="Local Mail"
		noun="saved queries and mail"
	>
		{#snippet children(app)}
		{#if mounted && app.account && showing}
			<mounted.Shell bind:this={shell} data={app.account.personal} />
		{/if}
		{/snippet}
	</AppBoot>
{:else}
	<Loading class="h-dvh" label="Opening Local Mail…" />
{/if}
