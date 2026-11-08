import seedlings from './seedlings.png?url';
import route from './weekend-route.txt?url&no-inline';

export type DemoAttachment =
	| { kind: 'image'; source: string; title: string; description: string }
	| {
			kind: 'file';
			source: string;
			title: string;
			description: string;
			filename: string;
	  };

/** Bundled fictional assets only. Live attachments never resolve through this map. */
export const demoAttachments: Record<string, DemoAttachment> = {
	'demo-garden-last': {
		kind: 'image',
		source: seedlings,
		title: 'Seedlings ready to collect',
		description:
			'Generated demo photo of tomato and basil seedlings on a sunny potting bench.',
	},
	'demo-noah-last': {
		kind: 'file',
		source: route,
		title: 'Weekend route.txt',
		description: 'A fictional walking plan. Sample text file.',
		filename: 'weekend-route.txt',
	},
};
