#!/usr/bin/env node

/**
 * Prints the ICN of each screenshot given, one per line.
 */

import { readScreenshot } from './index.js';

const USAGE = `Usage: infinite-chess-scanner [--black] [--verbose] <image...>

Reads the position off screenshots of an infinitechess.org board and prints each as an ICN.

  -b, --black     The screenshots show the board from black's side.
  -v, --verbose   Also print each screenshot's square size and the area it shows, to stderr.
  -h, --help      Show this help.`;

const args = process.argv.slice(2);
const verbose = args.some((arg) => arg === '-v' || arg === '--verbose');
const perspective = args.some((arg) => arg === '-b' || arg === '--black') ? 'black' : 'white';
const help = args.some((arg) => arg === '-h' || arg === '--help');
const files = args.filter((arg) => !arg.startsWith('-'));
if (help || files.length === 0) {
	console.error(USAGE);
	process.exit(help ? 0 : 1);
}

for (const file of files) {
	try {
		const reading = await readScreenshot(file, { perspective });
		console.log(files.length > 1 ? `${file}: ${reading.icn}` : reading.icn);
		if (verbose) {
			const { area, squareSize, pieces } = reading;
			console.error(`${file}: squares of ${squareSize.toFixed(2)}px, showing x ${area.left}..${area.right}, y ${area.bottom}..${area.top}, ${pieces.length} pieces`); // prettier-ignore
		}
	} catch (error) {
		console.error(`${file}: ${(error as Error).message}`);
		process.exitCode = 1;
	}
}
