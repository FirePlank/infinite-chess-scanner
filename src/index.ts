/**
 * Reads the position off a screenshot of an infinitechess.org board.
 *
 * The grid is found from the edges between the two tile colors, so any board theme, zoom and
 * crop works. Each fully visible square is matched against the site's own piece sprites, rendered
 * the way its WebGL renders them. Coordinates are relative, with all pieces at x>=1 and Black's
 * promotion rank at y=1 when exactly two promotion lines are visible. Otherwise, ranks stay centered
 * on the visible board. Dark squares have an even x+y as on the site.
 */

import type { PlacedPiece, Promotion, WorldBorder } from './icn.js';
import type { Reader } from './classify.js';
import type { Picture } from './picture.js';
import type { Sprite } from './sprites.js';
import type { Square, View } from './view.js';
import type { Tiles } from './tiles.js';
import type { BoardRegion } from './region.js';

import { classify } from './classify.js';
import { writeIcn } from './icn.js';
import { findViews } from './view.js';
import { abbreviate, VOID_CODE } from './pieces.js';
import { loadPicture } from './picture.js';
import { findTileColors } from './tiles.js';
import { findBoardRegion } from './region.js';
import { loadSprites } from './sprites.js';
import {
	chooseMatchers,
	fitTemplate,
	isBusy,
	patchSums,
	rankFits,
	sampleSquares,
} from './matcher.js';
import {
	anchorFrame,
	fileOf,
	findBoardExtent,
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
	/** Every board square read, as `x,y`. The rest are off screen, obscured, too small, or beyond a world border. */
	shown: Set<string>;
	/** The bounding box of the detected board region, including sky beyond a world border. */
	area: { left: number; right: number; bottom: number; top: number };
	/** The size of the largest square read, in pixels. Seen straight down, every square's. */
	squareSize: number;
	/** Whether the board is seen at an angle. */
	perspective: boolean;
}

export type { PlacedPiece, Promotion, WorldBorder } from './icn.js';

// Constants -------------------------------------------------------------------

/** How many squares, spread across the board's sizes, are searched for orientation evidence. */
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
	const { view, region } = chooseView(pic, findViews(pic, tiles), tiles, await sprites);
	const sampled = sampleSquares(pic, view.pieces.toImage, [
		...region.squares,
		...region.candidates,
	]);
	const direct = new Set(region.squares.map((square) => `${square.column},${square.row}`));
	const extent = tiles.photographed ? region.extent : findBoardExtent(sampled, tiles);
	const onBoard = sampled
		.filter(({ square }) => isWithin(square, extent))
		.sort((a, b) => a.square.row - b.square.row || a.square.column - b.square.column);
	const matchers = chooseMatchers(
		await sprites,
		onBoard.filter(({ square }) => direct.has(`${square.column},${square.row}`)),
		tiles.photographed,
	);
	const reader: Reader = { pic, view, darkTile: tiles[0] };
	const relativeFrame = frameOf(region.squares, region.darkParity, options.perspective === 'black'); // prettier-ignore

	const pieces: PlacedPiece[] = [];
	const accepted: Square[] = [];
	for (const sampled of onBoard) {
		const { square } = sampled;
		const verdict = classify(reader, sampled, matchers);
		if (verdict.kind === 'obscured') continue;
		if (!direct.has(`${square.column},${square.row}`)) {
			const neighbors = region.neighbors.get(`${square.column},${square.row}`)!;
			if (
				verdict.kind === 'empty' ||
				(neighbors < 3 && (verdict.kind !== 'piece' || verdict.piece.kind.code !== 'ob'))
			)
				continue;
		}
		accepted.push(square);
		if (verdict.kind === 'empty') continue;
		if (
			tiles.photographed &&
			verdict.kind === 'void' &&
			!region.voids.has(`${square.column},${square.row}`)
		)
			continue;
		const abbreviation = verdict.kind === 'void' ? VOID_CODE : abbreviate(verdict.piece);
		pieces.push({
			abbreviation,
			x: fileOf(relativeFrame, square.column),
			y: rankOf(relativeFrame, square.row),
		});
	}

	const lines = findPromotionLines(pic, view, accepted, tiles);
	const frame = anchorFrame(relativeFrame, pieces, readPromotion(lines, relativeFrame));
	const dx = fileOf(frame, 0) - fileOf(relativeFrame, 0);
	const dy = rankOf(frame, 0) - rankOf(relativeFrame, 0);
	for (const piece of pieces) {
		piece.x += dx;
		piece.y += dy;
	}
	const shown = new Set(accepted.map((square) => `${fileOf(frame, square.column)},${rankOf(frame, square.row)}`)); // prettier-ignore
	const promotion = readPromotion(lines, frame);
	const worldBorder = readWorldBorder(extent, [...region.squares, ...region.beyond], frame);
	const coordinates = [...region.squares, ...region.beyond].map((square): [number, number] => [fileOf(frame, square.column), rankOf(frame, square.row)]); // prettier-ignore
	const area = {
		left: Math.min(...coordinates.map(([x]) => x)),
		right: Math.max(...coordinates.map(([x]) => x)),
		bottom: Math.min(...coordinates.map(([, y]) => y)),
		top: Math.max(...coordinates.map(([, y]) => y)),
	};
	const squareSize = Math.max(...region.squares.map((square) => square.size));
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
function chooseView(
	pic: Picture,
	views: View[],
	tiles: Tiles,
	sprites: Sprite[],
): { view: View; region: BoardRegion } {
	const candidates: { view: View; region: BoardRegion }[] = [];
	let regionError: unknown;
	for (const view of views) {
		try {
			candidates.push({ view, region: findBoardRegion(pic, view, tiles) });
		} catch (error) {
			regionError = error;
		}
	}
	if (candidates.length === 0) throw regionError;
	if (candidates.length === 1) return candidates[0]!;
	const scores = candidates.map(({ view, region }) => {
		const ordered = [...region.squares].sort((a, b) => b.size - a.size);
		const stride = Math.max(1, Math.floor(ordered.length / ORIENTATION_SEARCH));
		const largest = ordered
			.filter((_, index) => index % stride === 0)
			.slice(0, ORIENTATION_SEARCH);
		const busy = sampleSquares(pic, view.pieces.toImage, largest).filter((square) =>
			isBusy(square),
		);
		const matchers = chooseMatchers(sprites, busy, tiles.photographed);
		if (busy.length === 0) return Infinity;
		const fits = busy.map(({ sizeClass, patch }) => {
			const matcher = matchers(sizeClass);
			const sums = patchSums(matcher, patch);
			const fit = rankFits(matcher, patch, sums)[0]!;
			const background = fitTemplate(matcher.empty, matcher, patch, sums);
			return { fit, score: fit.residual / Math.max(1e-6, background.residual) };
		});
		// Round obstacles give no orientation evidence. Use the pieces that have an upright shape.
		fits.sort((a, b) => a.score - b.score);
		const directional = fits
			.filter(({ fit }) => fit.template.sprite!.piece.kind.code !== 'ob')
			.slice(0, ORIENTATION_PIECES);
		const selected = directional.length ? directional : fits.slice(0, ORIENTATION_PIECES);
		return selected.reduce((sum, { score }) => sum + score, 0) / selected.length;
	});
	return candidates[scores.indexOf(Math.min(...scores))]!;
}
