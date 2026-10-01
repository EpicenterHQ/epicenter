import type { AgentEngine } from '@epicenter/agent';

/** Give providers a transient user turn for an empty tutor-first transcript. */
export function withTutorOpening(engine: AgentEngine): AgentEngine {
	return (request, signal) =>
		engine(
			request.messages.length > 0
				? request
				: {
						...request,
						messages: [{ role: 'user', content: 'Begin our conversation.' }],
					},
			signal,
		);
}
