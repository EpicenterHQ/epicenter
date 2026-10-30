// Deliberate type-only boundary: builds do not depend on generated, ignored files.
export type RequestId = string | number;
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type ThreadStatus =
	| { type: 'notLoaded' | 'idle' | 'systemError' }
	| {
			type: 'active';
			activeFlags: ('waitingOnApproval' | 'waitingOnUserInput')[];
	  };
export type TurnError = { message: string; additionalDetails?: string | null };
export type SessionSource =
	| 'cli'
	| 'vscode'
	| 'exec'
	| 'appServer'
	| 'unknown'
	| { custom: string }
	| { subAgent: unknown };
export type Thread = {
	id: string;
	name: string | null;
	preview: string;
	cwd: string;
	source: SessionSource;
	createdAt: number;
	updatedAt: number;
	status: ThreadStatus;
	gitInfo: { branch: string | null } | null;
	turns: Turn[];
};
export type UserInput =
	| { type: 'text'; text: string; text_elements: unknown[] }
	| ({ type: 'image'; detail?: string } & (
			| { url: string }
			| { fileId: string }
	  ))
	| { type: 'localImage'; path: string; detail?: string }
	| { type: 'audio'; url: string }
	| { type: 'localAudio'; path: string }
	| { type: 'skill' | 'mention'; name: string; path: string };
export type CommandExecutionStatus =
	| 'inProgress'
	| 'completed'
	| 'failed'
	| 'declined';
export type PatchApplyStatus =
	| 'inProgress'
	| 'completed'
	| 'failed'
	| 'declined';
export type PatchChangeKind =
	| { type: 'add' | 'delete' }
	| { type: 'update'; move_path: string | null };
export type FileUpdateChange = {
	path: string;
	kind: PatchChangeKind;
	diff: string;
};
export type KnownThreadItem =
	| {
			type: 'userMessage';
			id: string;
			clientId?: string | null;
			content: UserInput[];
	  }
	| {
			type: 'agentMessage';
			id: string;
			text: string;
			phase: 'commentary' | 'partial_answer' | 'final_answer' | null;
	  }
	| { type: 'reasoning'; id: string; summary: string[]; content: string[] }
	| {
			type: 'commandExecution';
			id: string;
			command: string;
			cwd: string;
			status: CommandExecutionStatus;
			aggregatedOutput: string | null;
			exitCode: number | null;
			durationMs: number | null;
	  }
	| {
			type: 'fileChange';
			id: string;
			changes: FileUpdateChange[];
			status: PatchApplyStatus;
	  }
	| { type: 'plan'; id: string; text: string }
	| {
			type: 'mcpToolCall';
			id: string;
			server: string;
			tool: string;
			status: 'inProgress' | 'completed' | 'failed';
	  }
	| {
			type: 'dynamicToolCall';
			id: string;
			tool: string;
			namespace: string | null;
			status: 'inProgress' | 'completed' | 'failed';
	  }
	| { type: 'webSearch'; id: string; query: string }
	| { type: 'contextCompaction'; id: string }
	| {
			type: 'enteredReviewMode' | 'exitedReviewMode';
			id: string;
			review: string;
	  }
	| { type: 'imageView'; id: string; path: string }
	| { type: 'sleep' | 'imageGeneration'; id: string }
	| { type: 'hookPrompt'; id: string; fragments: unknown[] }
	| {
			type: 'functionCallOutput';
			id: string;
			name: string;
			namespace: string | null;
			output: unknown;
	  }
	| { type: 'collabAgentToolCall'; id: string; tool: string; status: string }
	| {
			type: 'subAgentActivity';
			id: string;
			kind: string;
			agentThreadId: string;
			agentPath: string;
	  };
export type ThreadItem = KnownThreadItem | { type: string; id?: string };
export type Turn = {
	id: string;
	items: ThreadItem[];
	status: TurnStatus;
	error: TurnError | null;
	startedAt: number | null;
	completedAt: number | null;
	durationMs: number | null;
};
export type ThreadListResponse = { data: Thread[]; nextCursor: string | null };
export type ThreadTurnsListResponse = {
	data: Turn[];
	nextCursor: string | null;
};
export type ThreadReadResponse = { thread: Thread };
export type TurnStartResponse = { turn: Turn };
export type ApprovalDecision = 'accept' | 'decline';
export type ApprovalParams = {
	threadId: string;
	turnId: string;
	itemId: string;
	reason?: string | null;
};
export type CommandExecutionRequestApprovalParams = ApprovalParams & {
	command?: string | null;
	cwd?: string | null;
	networkApprovalContext?: { host: string; protocol: string } | null;
};
export type FileChangeRequestApprovalParams = ApprovalParams & {
	grantRoot?: string | null;
};
export type ApprovalResponse = { decision: ApprovalDecision };
export type RpcNotification = { method: string; params?: unknown };
export type RpcServerRequest = {
	id: RequestId;
	method: string;
	params?: unknown;
};
