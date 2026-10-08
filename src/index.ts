/**
 * Reads the position off a screenshot of an infinitechess.org board.
 *
 * The grid is found from the edges between the two tile colors, so any board theme, zoom and
 * crop works. Each fully visible square is matched against the site's own piece sprites, rendered
 * the way its WebGL renders them. Coordinates are relative, as a screenshot can't tell where on the
 * infinite board it is: the middle visible square becomes 0,0, nudged so that x+y is even on dark
 * squares as on the site.
 */

import type { PlacedPiece, Promotion, WorldBorder } from './icn.js';
import type { Reader } from './classify.js';
import type { Sprite } from './sprites.js';

import { classify } from './classify.js';
import { writeIcn } from './icn.js';
import { abbreviate, VOID_CODE } from './pieces.js';
import { loadPicture } from './picture.js';
import { findTileColors } from './tiles.js';
import { loadSprites } from './sprites.js';
import { chooseMatcher, innerMask } from './matcher.js';
import { findGrid, samplePatches, squareAt } from './grid.js';
import {
	fileOf,
	findBoardExtent,
	findDarkParity,
	findPromotionLines,
	frameOf,
	rankOf,
	readPromotion,
	readWorldBorder,
} from './board.js';

// Types -----------------------------------------------------------------------

/** How to read a screenshot. */
export interface Options {
	/** Whose side the screenshot shows the board from. Black's is drawn rotated 180°. White by default. */
	perspective?: 'white' | 'black';
}

/** What a screenshot shows. */
export interface Reading {
	/** The position as ICN. */
	icn: string;
	/** Every piece and void. */
	pieces: PlacedPiece[];
	/** The promotion ranks, when both sides' lines are visible. */
	promotion?: Promotion;
	/** The world border, on the sides where the board ends within the screenshot. */
	worldBorder?: WorldBorder;
	/** The inclusive area of the board the screenshot fully shows. */
	area: { left: number; right: number; bottom: number; top: number };
	/** The size of a square, in pixels. */
	squareSize: number;
}

export type { PlacedPiece, Promotion, WorldBorder } from './icn.js';

// Constants -------------------------------------------------------------------

/** Bounds of the samples per square side. Larger squares are box-averaged down to the max. */
const MIN_SAMPLES = 8;
const MAX_SAMPLES = 24;

// State -----------------------------------------------------------------------

/** The piece sprites, built on first use. */
let sprites: Promise<Sprite[]> | undefined;

// Functions -------------------------------------------------------------------

/**
 * Reads the position off a screenshot, given as an image file path or its bytes.
 * @throws If the image holds no checkerboard, or its squares are too small to read.
 */
export async function readScreenshot(
	input: string | Buffer,
	options: Options = {},
): Promise<Reading> {
	sprites ??= loadSprites();
	const pic = await loadPicture(input);
	const tiles = findTileColors(pic);
	const grid = findGrid(pic, tiles);

	const samples = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.round(grid.size)));
	const patches = samplePatches(pic, grid, samples);
	const extent = findBoardExtent(patches, tiles);
	const onBoard = patches
		.slice(extent.top, extent.bottom + 1)
		.map((line) => line.slice(extent.left, extent.right + 1));
	const matcher = chooseMatcher(await sprites, grid.size, samples, onBoard.flat());
	const reader: Reader = { pic, matcher, darkTile: tiles[0] };
	const darkParity = findDarkParity(onBoard, tiles, innerMask(samples));
	const flipped = options.perspective === 'black';
	const frame = frameOf(grid, (darkParity + extent.left + extent.top) % 2, flipped);

	const pieces: PlacedPiece[] = [];
	for (let row = extent.top; row <= extent.bottom; row++) {
		for (let column = extent.left; column <= extent.right; column++) {
			const verdict = classify(reader, squareAt(grid, column, row), patches[row]![column]!);
			if (verdict.kind === 'empty') continue;
			const abbreviation = verdict.kind === 'void' ? VOID_CODE : abbreviate(verdict.piece);
			pieces.push({ abbreviation, x: fileOf(frame, column), y: rankOf(frame, row) });
		}
	}

	const promotion = readPromotion(findPromotionLines(pic, grid, tiles), frame);
	const worldBorder = readWorldBorder(extent, grid, frame);
	const [x0, x1] = [fileOf(frame, 0), fileOf(frame, grid.x.count - 1)];
	const [y0, y1] = [rankOf(frame, grid.y.count - 1), rankOf(frame, 0)];
	const area = {
		left: Math.min(x0, x1),
		right: Math.max(x0, x1),
		bottom: Math.min(y0, y1),
		top: Math.max(y0, y1),
	};
	const icn = writeIcn(pieces, promotion, worldBorder);
	return { icn, pieces, promotion, worldBorder, area, squareSize: grid.size };
}
