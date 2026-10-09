/**
 * Reads every fixture screenshot and checks it against the position it shows, up to translation:
 * a screenshot can't tell where on the infinite board it is, only how its pieces sit relative to
 * one another. Every piece inside the screenshot must be read, and nothing else.
 */

import type { Reading } from '../src/index.js';

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

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
	/** Visible pieces and voids, guarding against an overly narrow board region. */
	minimumPieces?: number;
	/** Position squares covered by UI or foreground objects, which must not count as shown. */
	hiddenSquares?: string[];
	/** Exposed squares beside an occlusion, guarding against cropping away whole rows or columns. */
	visibleSquares?: string[];
	/** Independently known visible world-border sides: left, right, bottom, top. */
	worldBorderVisible?: [boolean, boolean, boolean, boolean];
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
	const coordinates = [...read.pieces.keys()].map(
		(key) => key.split(',').map(Number) as [number, number],
	);
	assert.ok(
		[1, 2].includes(Math.min(...coordinates.map(([x]) => x))),
		'The leftmost piece must be on file 1 or 2.',
	);
	if (reading.promotion?.white.length === 1 && reading.promotion.black.length === 1)
		assert.equal(reading.promotion.black[0], 1, "Black's promotion rank must be 1.");
	assert.deepEqual(
		new Map(reading.pieces.map(({ abbreviation, x, y }) => [`${x},${y}`, abbreviation])),
		read.pieces,
		'Piece coordinates in the API and ICN must agree.',
	);
	assert.deepEqual(
		reading.promotion,
		read.promotion ?? undefined,
		'Promotion coordinates in the API and ICN must agree.',
	);
	assert.deepEqual(
		reading.worldBorder && [
			reading.worldBorder.left,
			reading.worldBorder.right,
			reading.worldBorder.bottom,
			reading.worldBorder.top,
		],
		read.border,
		'World-border coordinates in the API and ICN must agree.',
	);
	for (const key of reading.shown) {
		const [x, y] = key.split(',').map(Number) as [number, number];
		assert.ok(
			x >= reading.area.left &&
				x <= reading.area.right &&
				y >= reading.area.bottom &&
				y <= reading.area.top,
			`Shown square ${key} lies outside the reported area.`,
		);
	}
	if (fixture.image === 'chess.png') {
		assert.equal(Math.min(...coordinates.map(([, y]) => y)), -3);
		assert.equal(Math.max(...coordinates.map(([, y]) => y)), 4);
	}
	if (fixture.minimumPieces !== undefined)
		assert.ok(
			read.pieces.size >= fixture.minimumPieces,
			`Only ${read.pieces.size} of at least ${fixture.minimumPieces} visible pieces were read.`,
		);
	const [dx, dy] = findTranslation(expected, read);
	const { area } = reading;
	assert.equal(Math.abs(dx + dy) % 2, 0, 'Light and dark squares are swapped.');
	for (const key of fixture.hiddenSquares ?? []) {
		const [x, y] = key.split(',').map(Number) as [number, number];
		assert.ok(
			!reading.shown.has(`${x + dx},${y + dy}`),
			`Covered square ${key} counted as shown.`,
		);
	}
	for (const key of fixture.visibleSquares ?? []) {
		const [x, y] = key.split(',').map(Number) as [number, number];
		assert.ok(
			reading.shown.has(`${x + dx},${y + dy}`),
			`Exposed square ${key} was excluded from the board region.`,
		);
	}

	for (const [key, piece] of expected.pieces) {
		const [x, y] = key.split(',').map(Number) as [number, number];
		const [rx, ry] = [x + dx, y + dy];
		if (!reading.shown.has(`${rx},${ry}`)) continue;
		assert.equal(read.pieces.get(`${rx},${ry}`), piece, `Piece at ${key}`);
	}
	for (const [key, piece] of read.pieces) {
		const [x, y] = key.split(',').map(Number) as [number, number];
		assert.ok(reading.shown.has(key), `Piece at ${key} lies outside the visible board region.`);
		assert.equal(
			expected.pieces.get(`${x - dx},${y - dy}`),
			piece,
			`Extra or wrong ${piece} at ${key}`,
		);
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
		index: number,
		shows: (v: number) => boolean,
	) =>
		value != null && (fixture.worldBorderVisible?.[index] ?? shows(value + shift))
			? value + shift
			: null;
	const border = [
		side(left, dx, 0, (v) => v > area.left),
		side(right, dx, 1, (v) => v < area.right),
		side(bottom, dy, 2, (v) => v > area.bottom),
		side(top, dy, 3, (v) => v < area.top),
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

for (const scenario of [
	{
		name: 'reads an embedded board with an opaque menu over empty squares',
		left: 749,
		top: 378,
		width: 102,
		height: 102,
		background: '#f1f1f1',
		minimumPieces: 32,
		hiddenSquares: ['4,4', '5,4', '4,5', '5,5'],
	},
	{
		name: 'excludes an opaque menu sharing the light tile color',
		left: 749,
		top: 378,
		width: 102,
		height: 102,
		background: '#ffd9a8',
		minimumPieces: 32,
		hiddenSquares: ['4,4', '5,4', '4,5', '5,5'],
	},
	{
		name: 'reads disconnected board regions around an opaque panel',
		left: 750,
		top: 0,
		width: 150,
		height: undefined,
		background: '#f1f1f1',
		minimumPieces: 20,
		hiddenSquares: [
			'4,1',
			'5,1',
			'6,1',
			'4,2',
			'5,2',
			'6,2',
			'4,7',
			'5,7',
			'6,7',
			'4,8',
			'5,8',
			'6,8',
		],
	},
	{
		name: 'excludes a square whose piece is partially covered by opaque UI',
		left: 825,
		top: 290,
		width: 25,
		height: 28,
		background: '#f1f1f1',
		minimumPieces: 31,
		hiddenSquares: ['5,7'],
	},
	{
		name: 'reads an L-shaped board region behind a panel touching the image boundary',
		left: -80,
		top: -100,
		width: 778,
		height: 430,
		background: '#f1f1f1',
		minimumPieces: 28,
		hiddenSquares: ['1,8', '2,8', '1,7', '2,7'],
	},
]) {
	test(scenario.name, async () => {
		const fixture = fixtures.find(({ image }) => image === 'classical.png')!;
		const board = fs.readFileSync(new URL(fixture.image, FIXTURES));
		const { width, height } = await sharp(board).metadata();
		const padding = { left: 80, top: 100 };
		// This fixture's squares are 50.5px across. Opaque UI covers the position
		// coordinates listed by each scenario; the remaining pieces are fully visible.
		const overlay = await sharp({
			create: {
				width: scenario.width,
				height: scenario.height ?? height!,
				channels: 3,
				background: scenario.background,
			},
		})
			.png()
			.toBuffer();
		const image = await sharp({
			create: {
				width: width! + 160,
				height: height! + 200,
				channels: 3,
				background: '#313a42',
			},
		})
			.composite([
				{ input: board, ...padding },
				{
					input: overlay,
					left: scenario.left + padding.left,
					top: scenario.top + padding.top,
				},
			])
			.png()
			.toBuffer();
		const reading = await readScreenshot(image);
		check(reading, {
			...fixture,
			minimumPieces: scenario.minimumPieces,
			hiddenSquares: scenario.hiddenSquares,
		});
	});
}

test('rejects squares too small to read', async () => {
	const file = new URL('space-too-far.png', FIXTURES);
	await assert.rejects(readScreenshot(fs.readFileSync(file)), /too small to read/);
});
