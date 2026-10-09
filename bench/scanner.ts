/**
 * Times warm reads of fixtures: the ones named, or a few representative screenshots and photos.
 * Run with `npm run benchmark -- [fixture.png ...]`.
 */

import fs from 'node:fs/promises';

import { readScreenshot } from '../src/index.js';

// Constants -------------------------------------------------------------------

/** The fixtures timed when none are named. */
const DEFAULT_FIXTURES = [
	'core.png',
	'space-tilted.png',
	'core-photo.png',
	'4x4x4x4-chess-photo-4.png',
	'abundance-photo.png',
	'obstocean-photo-blue.png',
];

/** How many timed reads each fixture gets, after one to warm up. */
const REPEATS = 3;

// Benchmark -------------------------------------------------------------------

const names = process.argv.slice(2);
for (const name of names.length > 0 ? names : DEFAULT_FIXTURES) {
	const input = await fs.readFile(new URL(`../test/fixtures/${name}`, import.meta.url));
	const reading = await readScreenshot(input);
	const elapsed: number[] = [];
	for (let repeat = 0; repeat < REPEATS; repeat++) {
		const started = performance.now();
		await readScreenshot(input);
		elapsed.push(performance.now() - started);
	}
	elapsed.sort((a, b) => a - b);
	console.log(
		JSON.stringify({
			image: name,
			medianMs: Math.round(elapsed[Math.floor(REPEATS / 2)]!),
			minimumMs: Math.round(elapsed[0]!),
			maximumMs: Math.round(elapsed[REPEATS - 1]!),
			pieces: reading.pieces.length,
			shown: reading.shown.size,
		}),
	);
}
