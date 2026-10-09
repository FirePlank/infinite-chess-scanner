/** Repeatable warm end-to-end measurements; run with npx tsx bench/scanner.ts [fixture.png ...]. */
import fs from 'node:fs/promises';

import { readScreenshot } from '../src/index.js';

const names = process.argv.slice(2);
const fixtures = names.length
	? names
	: [
			'core.png',
			'space-tilted.png',
			'core-photo.png',
			'4x4x4x4-chess-photo-4.png',
			'abundance-photo.png',
			'obstocean-photo-blue.png',
		];

for (const name of fixtures) {
	const input = await fs.readFile(new URL(`../test/fixtures/${name}`, import.meta.url));
	await readScreenshot(input);
	const elapsed: number[] = [];
	let reading;
	for (let repeat = 0; repeat < 3; repeat++) {
		const started = performance.now();
		reading = await readScreenshot(input);
		elapsed.push(performance.now() - started);
	}
	elapsed.sort((a, b) => a - b);
	console.log(
		JSON.stringify({
			image: name,
			medianMs: Math.round(elapsed[1]!),
			minimumMs: Math.round(elapsed[0]!),
			maximumMs: Math.round(elapsed[2]!),
			pieces: reading!.pieces.length,
			shown: reading!.shown.size,
		}),
	);
}
