/**
 * Reads every fixture screenshot and checks it against the position it shows, up to translation:
 * a screenshot can't tell where on the infinite board it is, only how its pieces sit relative to
 * one another. Every piece inside the screenshot must be read, and nothing else.
 */

import type { Reading } from '../src/index.js';

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { readScreenshot } from '../src/index.js';

// Types -----------------------------------------------------------------------

/** A screenshot and the ICN of the position it shows. */
interface Fixture {
	image: string;
	icn: string;
	/** When the promotion lines aren't read, as when zoomed out too far for both to be drawn. */
	promotionHidden?: true;
	/** Black's, when the screenshot shows the board from black's side. */
	perspective?: 'black';
}

/** The parts of an ICN the scanner reads. */
interface Position {
	pieces: Map<string, string>;
	promotion?: { white: number[]; black: number[] };
	border?: (number | null)[];
}

// Constants -------------------------------------------------------------------

const FIXTURES = new URL('./fixtures/', import.meta.url);

// Helpers ---------------------------------------------------------------------

/** Parses the pieces, promotion ranks and world border of an ICN. */
function parse(icn: string): Position {
	const fields = icn.trim().split(' ');
	const pieces = new Map<string, string>();
	for (const [, abbreviation, x, y] of fields.at(-1)!.matchAll(/(\d*[a-zA-Z]+)(-?\d+),(-?\d+)/g))
		pieces.set(`${x},${y}`, abbreviation!);
	const ranks = (list: string): number[] => (list ? list.split(',').map(Number) : []);
	const promotion = icn.match(/\(([-\d,]*)\|([-\d,]*)[;)]/);
	const border = fields.find((field) => /^(-?\d+|_)(,(-?\d+|_)){3}$/.test(field));
	return {
		pieces,
		promotion: promotion && { white: ranks(promotion[1]!), black: ranks(promotion[2]!) },
		border: border?.split(',').map((side) => (side === '_' ? null : Number(side))),
	};
}

/** The shift that lines the most expected pieces up with read ones of the same abbreviation. */
function findTranslation(expected: Position, read: Position): [number, number] {
	const votes = new Map<string, number>();
	for (const [readKey, readPiece] of read.pieces) {
		const [rx, ry] = readKey.split(',').map(Number) as [number, number];
		for (const [key, piece] of expected.pieces) {
			if (piece !== readPiece) continue;
			const [x, y] = key.split(',').map(Number) as [number, number];
			const shift = `${rx - x},${ry - y}`;
			votes.set(shift, (votes.get(shift) ?? 0) + 1);
		}
	}
	const [best] = [...votes].sort((a, b) => b[1] - a[1]);
	assert.ok(best, 'No piece was read.');
	return best[0].split(',').map(Number) as [number, number];
}

/** Checks a reading against the position its screenshot shows. */
function check(reading: Reading, fixture: Fixture): void {
	const expected = parse(fixture.icn);
	const read = parse(reading.icn);
	const [dx, dy] = findTranslation(expected, read);
	const { area } = reading;
	assert.equal(Math.abs(dx + dy) % 2, 0, 'Light and dark squares are swapped.');

	for (const [key, piece] of expected.pieces) {
		const [x, y] = key.split(',').map(Number) as [number, number];
		const [rx, ry] = [x + dx, y + dy];
		if (!reading.shown.has(`${rx},${ry}`)) continue;
		assert.equal(read.pieces.get(`${rx},${ry}`), piece, `Piece at ${key}`);
	}
	for (const [key, piece] of read.pieces) {
		const [x, y] = key.split(',').map(Number) as [number, number];
		assert.ok(expected.pieces.has(`${x - dx},${y - dy}`), `Extra ${piece} read at ${key}`);
	}

	const shifted = fixture.promotionHidden
		? undefined
		: expected.promotion && {
				white: expected.promotion.white.map((rank) => rank + dy),
				black: expected.promotion.black.map((rank) => rank + dy),
			};
	assert.deepEqual(read.promotion ?? undefined, shifted, 'Promotion ranks');

	// A border side shows only when the board ends inside the screenshot.
	const [left, right, bottom, top] = expected.border ?? [null, null, null, null];
	const side = (
		value: number | null | undefined,
		shift: number,
		shows: (v: number) => boolean,
	) => (value != null && shows(value + shift) ? value + shift : null);
	const border = [
		side(left, dx, (v) => v > area.left),
		side(right, dx, (v) => v < area.right),
		side(bottom, dy, (v) => v > area.bottom),
		side(top, dy, (v) => v < area.top),
	];
	const readBorder = read.border ?? [null, null, null, null];
	assert.deepEqual(readBorder, border, 'World border');
}

// Tests -----------------------------------------------------------------------

const fixtures: Fixture[] = JSON.parse(fs.readFileSync(new URL('fixtures.json', FIXTURES), 'utf8'));

for (const fixture of fixtures) {
	test(fixture.image, async () => {
		const image = fs.readFileSync(new URL(fixture.image, FIXTURES));
		const reading = await readScreenshot(image, { perspective: fixture.perspective });
		check(reading, fixture);
	});
}

test('rejects squares too small to read', async () => {
	const file = new URL('space-too-far.png', FIXTURES);
	await assert.rejects(readScreenshot(fs.readFileSync(file)), /too small to read/);
});
