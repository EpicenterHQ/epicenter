import type { DesktopRecordEpicenterOwner } from '@epicenter/data/desktop-record-owner';
import type {
	LensDefinition,
	RecordSyncState,
	ReplicaAttachment,
	ReplicaParkedWorkPage,
	ReplicaWorkSummary,
} from '@epicenter/data/record';

export const HOME_DATA_LENSES = ['chat', 'honeycrisp', 'whispering'] as const;
export type HomeDataLens = (typeof HOME_DATA_LENSES)[number];

export function isHomeDataLens(value: unknown): value is HomeDataLens {
	return HOME_DATA_LENSES.some((lens) => lens === value);
}

export type HomeDataCatalogEntry = {
	id: HomeDataLens;
	title: string;
	description: string;
	namespace: string;
	collections: {
		key: string;
		title: string;
		description?: string;
		kind: 'table' | 'values';
		fields: string[];
	}[];
};

export type HomeDataOverview = {
	lenses: HomeDataCatalogEntry[];
	attachment:
		| { kind: 'unattached'; requiresChoice: boolean }
		| { kind: 'attached'; attachment: ReplicaAttachment };
	sync: {
		state: RecordSyncState;
		work: ReplicaWorkSummary;
		authorityLifetime?: string;
		lastError?: { name: string; message: string };
	};
	parked: ReplicaParkedWorkPage;
};

export type HomeDataCollectionPage = {
	lens: HomeDataLens;
	collection: string;
	kind: 'table' | 'values';
	entries: {
		recordKey: string;
		state: 'live' | 'absent' | 'nonconforming';
		value?: unknown;
		message?: string;
	}[];
	nextAfter?: string;
};

type HomeDataOwner = Pick<
	DesktopRecordEpicenterOwner,
	'epicenter' | 'inspectTablePage'
>;

type ValueResult =
	| { data: unknown; error: null }
	| { data: null; error: { raw: unknown; message: string } };

type InspectableValue = { get(): Promise<ValueResult> };

/** Own Home's bounded, live, typed observation of the shared record owner. */
export function createHomeDataService({
	owner,
	lenses,
}: {
	owner: HomeDataOwner;
	lenses: Record<HomeDataLens, LensDefinition>;
}) {
	const catalog = (
		Object.entries(lenses) as [HomeDataLens, LensDefinition][]
	).map(
		([id, lens]): HomeDataCatalogEntry => ({
			id,
			title: lens.title,
			description: lens.description,
			namespace: lens.namespace,
			collections: Object.entries(lens.collections).map(
				([key, definition]) => ({
					key,
					title: definition.title,
					...(definition.description === undefined
						? {}
						: { description: definition.description }),
					kind: definition.kind,
					fields:
						definition.kind === 'table'
							? Object.keys(definition.fields)
							: Object.keys(definition.values),
				}),
			),
		}),
	);

	function selected(lensId: HomeDataLens, collectionKey: string) {
		const lens = lenses[lensId];
		const definition = lens.collections[collectionKey];
		if (definition === undefined) {
			throw new Error(`Lens '${lensId}' has no collection '${collectionKey}'`);
		}
		const bound = owner.epicenter.bind({ selected: lens }).selected as Record<
			string,
			unknown
		>;
		return { definition, collection: bound[collectionKey] };
	}

	return {
		async overview(): Promise<HomeDataOverview> {
			const status = owner.epicenter.syncStatus;
			return {
				lenses: structuredClone(catalog),
				attachment: structuredClone(owner.epicenter.attachment),
				sync: {
					state: status.state,
					work: structuredClone(status.work),
					...(status.authorityLifetime === undefined
						? {}
						: { authorityLifetime: status.authorityLifetime }),
					...(status.lastError === undefined
						? {}
						: {
								lastError: {
									name: status.lastError.name,
									message: status.lastError.message,
								},
							}),
				},
				parked: await owner.epicenter.parkedWork(),
			};
		},

		async collection({
			lens: lensId,
			collection: collectionKey,
			after,
			limit = 100,
		}: {
			lens: HomeDataLens;
			collection: string;
			after?: string;
			limit?: number;
		}): Promise<HomeDataCollectionPage> {
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
				throw new Error('Home data page limit must be 1 through 100');
			}
			const { definition, collection } = selected(lensId, collectionKey);
			if (definition.kind === 'table') {
				const page = owner.inspectTablePage({
					lens: lenses[lensId],
					collection: collectionKey,
					...(after === undefined ? {} : { after }),
					limit,
				});
				return {
					lens: lensId,
					collection: collectionKey,
					kind: 'table',
					entries: page.entries.map((entry) =>
						entry.error === null
							? {
									recordKey: String(entry.data.id),
									state: 'live' as const,
									value: entry.data,
								}
							: {
									recordKey: entry.error.id,
									state: 'nonconforming' as const,
									value: entry.error.raw,
									message: entry.error.message,
								},
					),
					...(page.nextAfter === undefined
						? {}
						: { nextAfter: page.nextAfter }),
				};
			}

			const values = collection as Record<string, InspectableValue>;
			const entries = await Promise.all(
				Object.keys(definition.values).map(async (recordKey) => {
					const result = await values[recordKey]?.get();
					if (result === undefined) {
						throw new Error(`Value '${recordKey}' is not bound`);
					}
					if (result.error !== null) {
						return {
							recordKey,
							state: 'nonconforming' as const,
							value: result.error.raw,
							message: result.error.message,
						};
					}
					return result.data === undefined
						? { recordKey, state: 'absent' as const }
						: {
								recordKey,
								state: 'live' as const,
								value: result.data,
							};
				}),
			);
			return {
				lens: lensId,
				collection: collectionKey,
				kind: 'values',
				entries,
			};
		},
	};
}

export type HomeDataService = ReturnType<typeof createHomeDataService>;
