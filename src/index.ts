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
import type { Picture } from './picture.js';
import type { Sprite } from './sprites.js';
import type { View } from './view.js';

import { classify } from './classify.js';
import { writeIcn } from './icn.js';
import { findViews } from './view.js';
import { abbreviate, VOID_CODE } from './pieces.js';
import { loadPicture } from './picture.js';
import { findTileColors } from './tiles.js';
import { loadSprites } from './sprites.js';
import { chooseMatchers, isBusy, patchSums, rankFits, sampleSquares } from './matcher.js';
import {
	fileOf,
	findBoardExtent,
	findDarkParity,
	findPromotionLines,
	frameOf,
	isWithin,
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
	/** Every board square read, as `x,y`. The rest are off screen, too small to read, or beyond a world border. */
	shown: Set<string>;
	/** The bounding box of every square on screen large enough to read, world border or not. */
	area: { left: number; right: number; bottom: number; top: number };
	/** The size of the largest square read, in pixels. Seen straight down, every square's. */
	squareSize: number;
	/** Whether the board is seen at an angle. */
	perspective: boolean;
}

export type { PlacedPiece, Promotion, WorldBorder } from './icn.js';

// Constants -------------------------------------------------------------------

/** How many of the largest squares are searched for pieces to tell the board's orientation by. */
const ORIENTATION_SEARCH = 400;

/** How many pieces tell the board's orientation. */
const ORIENTATION_PIECES = 24;

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
	const view = chooseView(pic, findViews(pic, tiles), await sprites);
	const sampled = sampleSquares(pic, view.pieces.toImage, view.squares);
	const extent = findBoardExtent(sampled, tiles);
	const onBoard = sampled
		.filter(({ square }) => isWithin(square, extent))
		.sort((a, b) => a.square.row - b.square.row || a.square.column - b.square.column);
	const matchers = chooseMatchers(await sprites, onBoard);
	const reader: Reader = { pic, view, darkTile: tiles[0] };
	const frame = frameOf(view.squares, findDarkParity(onBoard, tiles), options.perspective === 'black'); // prettier-ignore

	const pieces: PlacedPiece[] = [];
	for (const sampled of onBoard) {
		const { square } = sampled;
		const verdict = classify(reader, sampled, matchers);
		if (verdict.kind === 'empty') continue;
		const abbreviation = verdict.kind === 'void' ? VOID_CODE : abbreviate(verdict.piece);
		pieces.push({
			abbreviation,
			x: fileOf(frame, square.column),
			y: rankOf(frame, square.row),
		});
	}

	const promotion = readPromotion(findPromotionLines(pic, view, view.squares, tiles), frame);
	const worldBorder = readWorldBorder(extent, view.squares, frame);
	const shown = new Set(onBoard.map(({ square }) => `${fileOf(frame, square.column)},${rankOf(frame, square.row)}`)); // prettier-ignore
	const coordinates = view.squares.map((square): [number, number] => [fileOf(frame, square.column), rankOf(frame, square.row)]); // prettier-ignore
	const area = {
		left: Math.min(...coordinates.map(([x]) => x)),
		right: Math.max(...coordinates.map(([x]) => x)),
		bottom: Math.min(...coordinates.map(([, y]) => y)),
		top: Math.max(...coordinates.map(([, y]) => y)),
	};
	const squareSize = Math.max(...view.squares.map((square) => square.size));
	const icn = writeIcn(pieces, promotion, worldBorder);
	return {
		icn,
		pieces,
		promotion,
		worldBorder,
		shown,
		area,
		squareSize,
		perspective: view.perspective,
	};
}

/** Of the ways the board might sit, the one its largest pieces fit best standing as drawn. */
function chooseView(pic: Picture, views: View[], sprites: Sprite[]): View {
	if (views.length === 1) return views[0]!;
	const scores = views.map((view) => {
		const largest = [...view.squares]
			.sort((a, b) => b.size - a.size)
			.slice(0, ORIENTATION_SEARCH);
		const busy = sampleSquares(pic, view.pieces.toImage, largest)
			.filter((square) => isBusy(square))
			.slice(0, ORIENTATION_PIECES);
		const matchers = chooseMatchers(sprites, busy);
		return busy.reduce((sum, { sizeClass, patch }) => {
			const matcher = matchers(sizeClass);
			return sum + rankFits(matcher, patch, patchSums(matcher, patch))[0]!.residual;
		}, 0);
	});
	return views[scores.indexOf(Math.min(...scores))]!;
}
