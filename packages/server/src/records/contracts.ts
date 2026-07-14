import type { PrincipalId } from '@epicenter/identity';
import type {
	PullRequest,
	PullResponse,
	PushRequest,
	PushResponse,
	RecordAuthorityOpenRequest,
	RecordAuthorityOpenResult,
	SnapshotChunkRequest,
	SnapshotChunkResponse,
	TablesApplyRequest,
	TablesApplyResponse,
	TablesStateRequest,
	TablesStateResponse,
} from '@epicenter/record-sync';

/** The authenticated server partition selected outside the record-sync protocol. */
export type RecordsPartition = {
	principalId: PrincipalId;
	workspaceId: string;
};

/** Portable authority backend used by HTTP routes and runtime-specific stores. */
export type Records = {
	open(
		partition: RecordsPartition,
		request: RecordAuthorityOpenRequest,
	): Promise<RecordAuthorityOpenResult>;
	push(
		partition: RecordsPartition,
		request: PushRequest,
	): Promise<PushResponse>;
	pull(
		partition: RecordsPartition,
		request: PullRequest,
	): Promise<PullResponse>;
	snapshotChunk(
		partition: RecordsPartition,
		request: SnapshotChunkRequest,
	): Promise<SnapshotChunkResponse>;
	readTablesState(
		partition: RecordsPartition,
		request: TablesStateRequest,
	): Promise<TablesStateResponse>;
	applyTables(
		partition: RecordsPartition,
		request: TablesApplyRequest,
	): Promise<TablesApplyResponse>;
};
