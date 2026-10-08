/**
 * Reads screenshots for the command line: in its own thread when the command line reads several
 * at once, each worker taking the next screenshot as it finishes one.
 */

import type { Options } from './index.js';

import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import { readScreenshot } from './index.js';

// Types -----------------------------------------------------------------------

/** What reading a screenshot printed: its ICN and a note on what it showed, or why it failed. */
export type Outcome = { icn: string; note: string } | { error: string };

// Functions -------------------------------------------------------------------

/** Reads a screenshot into what the command line prints for it. */
export async function describe(file: string, options: Options): Promise<Outcome> {
	try {
		const { icn, area, squareSize, pieces, perspective } = await readScreenshot(file, options);
		const angle = perspective ? ', seen at an angle' : '';
		const note = `squares of ${squareSize.toFixed(2)}px${angle}, showing x ${area.left}..${area.right}, y ${area.bottom}..${area.top}, ${pieces.length} pieces`; // prettier-ignore
		return { icn, note };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

// Worker ----------------------------------------------------------------------

if (!isMainThread) {
	const options = workerData as Options;
	parentPort!.on('message', async ({ index, file }: { index: number; file: string }) => {
		parentPort!.postMessage({ index, outcome: await describe(file, options) });
	});
}
