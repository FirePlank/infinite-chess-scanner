import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import sharp from 'sharp';

import { readScreenshot } from '../src/index.js';

type Color = [number, number, number];

// These layouts and palettes do not come from captured boards. Rasterize the source SVGs
// directly, then apply the camera transfer to the whole image, independently of the matcher.
const KINDS = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
const CODES = ['k', 'q', 'r', 'b', 'n', 'p'];
const POSITIONS = [
	[3, 3],
	[12, 4],
	[5, 10],
	[10, 11],
	[7, 5],
	[13, 9],
	[11, 3],
	[4, 5],
	[13, 11],
	[6, 8],
	[3, 12],
	[10, 6],
] as const;

interface Capture {
	name: string;
	dark: Color;
	light: Color;
	size: number;
	skew: number;
	phase: number;
	camera: boolean;
	densePawns?: boolean;
	broadNoise?: boolean;
	promotion?: { boundaries: [number, number]; color: Color };
}

const captures: Capture[] = [
	{
		name: 'green theme, diagonal display stripes',
		dark: [0.27, 0.38, 0.3],
		light: [0.62, 0.73, 0.55],
		size: 38,
		skew: 0.1,
		phase: 0.3,
		camera: true,
	},
	{
		name: 'gray theme, reversed stripe phase and skew',
		dark: [0.38, 0.38, 0.38],
		light: [0.67, 0.67, 0.67],
		size: 41,
		skew: -0.08,
		phase: 1.7,
		camera: true,
	},
	{
		name: 'violet theme screenshot',
		dark: [0.4, 0.25, 0.42],
		light: [0.79, 0.64, 0.81],
		size: 38,
		skew: 0,
		phase: 0,
		camera: false,
	},
	{
		name: 'faded gray tiles under display noise',
		dark: [0.4, 0.4, 0.4],
		light: [0.48, 0.48, 0.48],
		size: 38,
		skew: 0.07,
		phase: 0.9,
		camera: true,
	},
	{
		name: 'localized broad RGB bands under fine display noise',
		dark: [0.27, 0.38, 0.3],
		light: [0.62, 0.73, 0.55],
		size: 38,
		skew: 0.1,
		phase: 0.3,
		camera: true,
		broadNoise: true,
	},
	{
		name: 'dense interleaved pawn ranks under display noise',
		dark: [0.38, 0.38, 0.38],
		light: [0.67, 0.67, 0.67],
		size: 41,
		skew: -0.08,
		phase: 1.7,
		camera: true,
		densePawns: true,
	},
	{
		name: 'colored promotion strokes under display noise',
		dark: [0.38, 0.38, 0.38],
		light: [0.67, 0.67, 0.67],
		size: 41,
		skew: -0.08,
		phase: 1.7,
		camera: true,
		promotion: { boundaries: [2, 13], color: [0.36, 0.09, 0.14] },
	},
];

interface DrawnPiece {
	column: number;
	row: number;
	kind: string;
	player: string;
	abbreviation: string;
}

function layout(capture: Capture): DrawnPiece[] {
	const pieces: DrawnPiece[] = POSITIONS.map(([column, row], i) => ({
		column,
		row,
		kind: KINDS[i % 6]!,
		player: i < 6 ? 'white' : 'black',
		abbreviation: i < 6 ? CODES[i]!.toUpperCase() : CODES[i - 6]!,
	}));
	if (capture.densePawns) {
		for (const row of [7, 8]) {
			for (let column = 2; column <= 14; column++) {
				if (pieces.some((piece) => piece.column === column && piece.row === row)) continue;
				const white = (column + row) % 2 === 0;
				pieces.push({
					column,
					row,
					kind: 'pawn',
					player: white ? 'white' : 'black',
					abbreviation: white ? 'P' : 'p',
				});
			}
		}
	}
	return pieces;
}

async function render(capture: Capture): Promise<Buffer> {
	const { size, skew, phase, camera, dark, light } = capture;
	const pieces = layout(capture);
	const file = await fs.readFile(
		new URL('../assets/pieces/classical.svg', import.meta.url),
		'utf8',
	);
	const glyphs = await Promise.all(
		pieces.map(async ({ kind, player }) => {
			const id = `${kind}-${player}`;
			const svg = [...file.matchAll(/<svg\b[^>]*\sid="([^"]*)"[\s\S]*?<\/svg>/g)].find(
				([, found]) => found === id,
			)![0];
			return sharp(
				Buffer.from(svg.replace('<svg', `<svg width="${4 * size}" height="${4 * size}"`)),
			)
				.resize(size, size)
				.ensureAlpha()
				.raw()
				.toBuffer();
		}),
	);
	const occupied = new Map(pieces.map(({ column, row }, i) => [`${column},${row}`, i]));
	const width = size * 17;
	const height = size * 15;
	const data = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = (x + 0.5 - skew * (y - height / 2)) / size + 0.25;
			const v = (y + 0.5) / size + 0.25;
			const column = Math.floor(u);
			const row = Math.floor(v);
			const tile = (column + row) % 2 === 0 ? dark : light;
			const glyph = occupied.get(`${column},${row}`);
			const pixel =
				(Math.min(size - 1, Math.floor((v - row) * size)) * size +
					Math.min(size - 1, Math.floor((u - column) * size))) *
				4;
			const alpha = glyph === undefined ? 0 : glyphs[glyph]![pixel + 3]! / 255;
			for (let c = 0; c < 3; c++) {
				let color =
					tile[c]! * (1 - alpha) +
					(glyph === undefined ? 0 : glyphs[glyph]![pixel + c]! / 255) * alpha;
				if (
					capture.promotion?.boundaries.some((boundary) => Math.abs(v - boundary) < 0.025)
				)
					color = capture.promotion.color[c]!;
				if (camera) {
					const illumination = 0.76 + (0.1 * x) / width + 0.035 * Math.sin(y / 170);
					const stripes =
						[0.065, 0.09, 0.1][c]! *
						Math.sin((2 * Math.PI * (x + 0.19 * y)) / 2.7 + phase + c * 1.3);
					color = illumination * color + [0.045, 0.065, 0.08][c]! + stripes;
					if (capture.broadNoise) {
						const envelope = Math.exp(-(((y / height - 0.5) / 0.22) ** 2));
						color +=
							envelope *
							[0.045, 0.06, 0.04][c]! *
							Math.sin((2 * Math.PI * (y + 0.15 * x)) / 16.7 + phase + c * 0.8);
					}
				}
				data[(y * width + x) * 3 + c] = Math.round(255 * Math.max(0, Math.min(1, color)));
			}
		}
	}
	return sharp(data, { raw: { width, height, channels: 3 } })
		.png()
		.toBuffer();
}

for (const capture of captures) {
	test(`reads an independently generated board: ${capture.name}`, async () => {
		const reading = await readScreenshot(await render(capture));
		const drawn = layout(capture);
		assert.equal(
			reading.pieces.length,
			drawn.length,
			'Every drawn piece, with no invented glyphs',
		);
		const expected = drawn.map(({ column, row, abbreviation }) => ({
			abbreviation,
			x: column,
			y: -row,
		}));
		const anchor = reading.pieces.find(({ abbreviation }) => abbreviation === 'K');
		assert.ok(anchor, 'White king');
		const dx = anchor.x - expected[0]!.x;
		const dy = anchor.y - expected[0]!.y;
		assert.equal(Math.abs(dx + dy) % 2, 0, 'Tile parity');
		for (const piece of expected) {
			const key = `${piece.x + dx},${piece.y + dy}`;
			assert.ok(reading.shown.has(key), `Visible piece square ${key}`);
			assert.equal(
				reading.pieces.find(({ x, y }) => `${x},${y}` === key)?.abbreviation,
				piece.abbreviation,
				key,
			);
		}
		for (const [column, row] of [
			[8, 9],
			[2, 5],
			[14, 12],
		])
			assert.ok(reading.shown.has(`${column + dx},${-row + dy}`), 'Visible empty square');
		assert.deepEqual(
			reading.promotion,
			capture.promotion && {
				white: [-capture.promotion.boundaries[0] + dy],
				black: [1 - capture.promotion.boundaries[1] + dy],
			},
			'Promotion strokes, without invented display-stripe boundaries',
		);
		assert.equal(reading.worldBorder, undefined, 'Continuous checkerboard');
	});
}
