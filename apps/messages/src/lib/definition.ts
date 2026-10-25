import { Type } from 'typebox';

/** Compositions and the latest send attempt have separate write authorities. */
export const messagesTables = {
	drafts: Type.Object({
		chatId: Type.String(),
		profile: Type.String(),
		mode: Type.Union([Type.Literal('demo'), Type.Literal('live')]),
	}),
	attempts: Type.Object({
		chatId: Type.String(),
		profile: Type.String(),
		mode: Type.Union([Type.Literal('demo'), Type.Literal('live')]),
		state: Type.Union([
			Type.Literal('sending'),
			Type.Literal('accepted'),
			Type.Literal('acknowledged'),
		]),
		attemptId: Type.String(),
		pendingId: Type.String(),
	}),
};
