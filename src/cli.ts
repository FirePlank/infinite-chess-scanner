#!/usr/bin/env node

/**
 * Prints the ICN of each screenshot given, one per line, in order. Several screenshots are read
 * at once, one per spare core.
 */

import type { Options } from './index.js';
import type { Outcome } from './worker.js';

import os from 'node:os';
import { Worker } from 'node:worker_threads';

import { describe } from './worker.js';

const USAGE = `Usage: infinite-chess-scanner [--black] [--verbose] <image...>

Reads the position off screenshots of an infinitechess.org board and prints each as an ICN.

  -b, --black     The screenshots show the board from black's side.
  -v, --verbose   Also print each screenshot's square size and the area it shows, to stderr.
  -h, --help      Show this help.`;

const args = process.argv.slice(2);
const verbose = args.some((arg) => arg === '-v' || arg === '--verbose');
const options: Options = {
	perspective: args.some((arg) => arg === '-b' || arg === '--black') ? 'black' : 'white',
};
const help = args.some((arg) => arg === '-h' || arg === '--help');
const files = args.filter((arg) => !arg.startsWith('-'));
if (help || files.length === 0) {
	console.error(USAGE);
	process.exit(help ? 0 : 1);
}

const outcomes: Outcome[] = [];
let printed = 0;
if (files.length === 1) report(0, await describe(files[0]!, options));
else await readInWorkers();

/** Reads the screenshots on worker threads, handing each the next one as it finishes. */
async function readInWorkers(): Promise<void> {
	let next = 0;
	const threads = Math.min(files.length, Math.max(1, os.availableParallelism() - 1));
	const worker = (): Promise<void> =>
		new Promise((resolve, reject) => {
			const thread = new Worker(new URL('./worker.js', import.meta.url), {
				workerData: options,
			});
			const hand = (): void => {
				if (next < files.length) thread.postMessage({ index: next, file: files[next++] });
				else void thread.terminate().then(() => resolve());
			};
			thread.on('message', ({ index, outcome }: { index: number; outcome: Outcome }) => {
				report(index, outcome);
				hand();
			});
			thread.on('error', reject);
			hand();
		});
	await Promise.all(Array.from({ length: threads }, () => worker()));
}

/** Records a screenshot's outcome, printing every outcome now in order. */
function report(index: number, outcome: Outcome): void {
	outcomes[index] = outcome;
	for (; outcomes[printed]; printed++) {
		const file = files[printed]!;
		const done = outcomes[printed]!;
		if ('error' in done) {
			console.error(`${file}: ${done.error}`);
			process.exitCode = 1;
			continue;
		}
		console.log(files.length > 1 ? `${file}: ${done.icn}` : done.icn);
		if (verbose) console.error(`${file}: ${done.note}`);
	}
}
