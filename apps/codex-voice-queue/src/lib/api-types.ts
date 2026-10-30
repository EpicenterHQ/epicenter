import type {
	FileUpdateChange,
	RequestId,
	ThreadStatus,
	Turn,
	TurnStatus,
} from './protocol.js';

export type Sandbox = 'workspace-write' | 'read-only';
export type ApprovalPolicy = 'on-request' | 'untrusted';
export type AppServerState = {
	state: 'starting' | 'ready' | 'down';
	lastError: string | null;
};
export type ThreadSummary = {
	id: string;
	title: string;
	preview: string;
	cwd: string;
	source: string;
	createdAt: number;
	updatedAt: number;
	status: ThreadStatus;
	gitBranch: string | null;
	live?: LiveTurn;
};
export type LiveTurn = {
	turnId: string;
	status: TurnStatus;
	startedAt: number | null;
	completedAt: number | null;
	error: string | null;
	lastAgentMessage: string;
	threadStatus: ThreadStatus | null;
};
export type PendingApproval = {
	id: string;
	requestId: RequestId;
	method: string;
	threadId: string;
	turnId: string;
	itemId: string;
	kind: 'command' | 'fileChange';
	changes: FileUpdateChange[] | null;
	changesTruncated: boolean;
	command?: string | null;
	cwd?: string | null;
	reason?: string | null;
	grantRoot?: string | null;
	networkHost?: string | null;
	createdAt: number;
};
export type Notice = {
	id: string;
	threadId: string | null;
	at: number;
	message: string;
};
export type GatewayState = {
	bootId: string;
	appServer: AppServerState;
	live: Record<string, LiveTurn>;
	approvals: PendingApproval[];
	notices: Notice[];
};
export type TranscriptionProbe = {
	available: boolean;
	reason: string | null;
	model: string | null;
};
export type Health = {
	bootId: string;
	appServer: AppServerState & { stderr: string[] };
	transcription: TranscriptionProbe;
	policy: { sandbox: Sandbox; approval: ApprovalPolicy };
	version: string;
};
export type ThreadsResponse = { threads: ThreadSummary[]; truncated: boolean };
export type TurnsResponse = {
	turns: Turn[];
	nextCursor: string | null;
	allLoaded: boolean;
	fallback?: 'thread/read';
};
export type SendRequest = {
	text: string;
	replyId: string;
	retry?: boolean;
	bootId?: string;
};
export type SendResponse = {
	turnId: string;
	status: TurnStatus;
	replyId: string;
	duplicate: boolean;
};
export type ApiErrorCode =
	| 'busy'
	| 'reply_conflict'
	| 'outcome_unknown'
	| 'validation'
	| 'app_server'
	| 'unauthorized'
	| 'rate_limited'
	| 'not_found'
	| 'internal';
export type TranscriptionResponse = {
	text: string;
	durationMs: number;
	model: string;
};
