<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	// ── Metrics ────────────────────────────────────────────────────────────────

	function createMetrics() {
		function snapshot() {
			return {
				tables: [
					{
						label: 'Recordings',
						count: app.library.tables.recordings.rows.length,
					},
					{
						label: 'Recipes',
						count: app.personal?.tables.recipes.rows.length ?? 0,
					},
				],
				nonconforming:
					app.library.tables.recordings.nonconforming.length +
					(app.personal?.tables.recipes.nonconforming.length ?? 0),
			};
		}

		let current = $state.raw(snapshot());

		return {
			get current() {
				return current;
			},
			refresh() {
				current = snapshot();
			},
		};
	}

	// ── Instance ──────────────────────────────────────────────────────────────

	const metrics = createMetrics();
</script>

{#if import.meta.env.DEV}
	<div class="space-y-8">
		<!-- Page Header -->
		<SectionHeader.Root>
			<div class="flex items-center gap-3">
				<SectionHeader.Title level={3} class="text-xl tracking-tight">
					Debug
				</SectionHeader.Title>
			</div>
			<SectionHeader.Description class="max-w-2xl">
				Workspace metrics. Only visible in development.
			</SectionHeader.Description>
		</SectionHeader.Root>

		<!-- Workspace Metrics -->
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						<DatabaseIcon class="h-4 w-4 text-muted-foreground" />
						<Card.Title class="text-base font-medium"
							>Workspace Metrics</Card.Title
						>
					</div>
					<Button variant="outline" size="sm" onclick={() => metrics.refresh()}>
						<RefreshCwIcon class="mr-1.5 h-3.5 w-3.5" />
						Refresh
					</Button>
				</div>
			</Card.Header>
			<Card.Content>
				<div class="space-y-4">
					<div class="flex items-center justify-between rounded-md border p-3">
						<span class="text-sm text-muted-foreground"
							>Nonconforming canonical records</span
						>
						<span class="font-mono text-sm font-medium">
							{metrics.current.nonconforming.toLocaleString()}
						</span>
					</div>

					<!-- Table Row Counts -->
					<div class="grid gap-2">
						{#each metrics.current.tables as table}
							<div
								class="flex items-center justify-between rounded-md border px-3 py-2"
							>
								<span class="text-sm text-muted-foreground">{table.label}</span>
								<span class="font-mono text-sm font-medium"
									>{table.count.toLocaleString()}</span
								>
							</div>
						{/each}
					</div>
				</div>
			</Card.Content>
		</Card.Root>
	</div>
{/if}
