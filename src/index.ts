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
import type { Square, View } from './view.js';
import type { Tiles } from './tiles.js';
import type { BoardRegion } from './region.js';
import type { SampledSquare } from './matcher.js';

import { classify } from './classify.js';
import { writeIcn } from './icn.js';
import { findViews } from './view.js';
import { abbreviate, VOID_CODE } from './pieces.js';
import { loadPicture } from './picture.js';
import { findTileColors } from './tiles.js';
import { findBoardRegion, isObstructed, openRegion } from './region.js';
import { loadSprites } from './sprites.js';
import {
	chooseMatchers,
	fitTemplate,
	isBusy,
	isPhotographicBackground,
	patchSums,
	rankFits,
	sampleSquares,
} from './matcher.js';
import {
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

/** Where the board sits in a screenshot, which of its squares show, and those squares sampled. */
interface Board {
	view: View;
	region: BoardRegion;
	sampled: SampledSquare[];
	/** Whether something covers part of the board: a menu, the browser around it, or a photo's foreground. */
	obstructed: boolean;
}

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
	const views = findViews(pic, tiles);
	const open = tiles.photographed ? undefined : openBoard(pic, tiles, views, await sprites);
	const read = open && readBoard(pic, tiles, open, await sprites, options);
	if (read && !read.covered) return read.reading;
	return readBoard(pic, tiles, obstructedBoard(pic, tiles, views, await sprites), await sprites, options).reading; // prettier-ignore
}

/** Reads a board's position, skipping covered squares, and whether it met any. */
function readBoard(
	pic: Picture,
	tiles: Tiles,
	{ view, region, sampled, obstructed }: Board,
	sprites: Sprite[],
	options: Options,
): { reading: Reading; covered: boolean } {
	const direct = new Set(region.squares.map((square) => `${square.column},${square.row}`));
	const onBoard = sampled
		.filter(({ square }) => isWithin(square, region.extent))
		.sort((a, b) => a.square.row - b.square.row || a.square.column - b.square.column);
	const matchers = chooseMatchers(
		sprites,
		onBoard.filter(({ square }) => {
			const key = `${square.column},${square.row}`;
			return direct.has(key) && (!tiles.photographed || !region.voids.has(key));
		}),
		tiles.photographed,
	);
	// At an angle, promotion lines reach into the squares beside them, which reads like a cover.
	const reader: Reader = {
		pic,
		view,
		tiles,
		inferred: region.inferred,
		detectsCovers: obstructed || !view.perspective,
	};
	const frame = frameOf(region.squares, region.darkParity, options.perspective === 'black'); // prettier-ignore

	const pieces: PlacedPiece[] = [];
	const shown = new Set<string>();
	const accepted: Square[] = [];
	let covered = false;
	for (const sampled of onBoard) {
		const { square } = sampled;
		const verdict =
			tiles.photographed &&
			direct.has(`${square.column},${square.row}`) &&
			region.voids.has(`${square.column},${square.row}`)
				? { kind: 'void' as const }
				: classify(reader, sampled, matchers);
		if (verdict.kind === 'obscured') {
			covered = true;
			continue;
		}
		if (!direct.has(`${square.column},${square.row}`)) {
			const neighbors = region.neighbors.get(`${square.column},${square.row}`)!;
			const edge =
				square.column === region.extent.left ||
				square.column === region.extent.right ||
				square.row === region.extent.top ||
				square.row === region.extent.bottom;
			const minimumNeighbors = tiles.photographed && edge ? 2 : 3;
			if (
				verdict.kind === 'empty' ||
				(tiles.photographed && verdict.kind === 'void') ||
				(neighbors < minimumNeighbors &&
					(verdict.kind !== 'piece' || verdict.piece.kind.code !== 'ob'))
			)
				continue;
		}
		accepted.push(square);
		shown.add(`${fileOf(frame, square.column)},${rankOf(frame, square.row)}`);
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
			x: fileOf(frame, square.column),
			y: rankOf(frame, square.row),
		});
	}

	const promotion = readPromotion(findPromotionLines(pic, view, accepted, tiles), frame);
	const worldBorder = readWorldBorder(region.extent, [...region.squares, ...region.beyond], frame); // prettier-ignore
	const coordinates = [...region.squares, ...region.beyond].map((square): [number, number] => [fileOf(frame, square.column), rankOf(frame, square.row)]); // prettier-ignore
	const area = {
		left: Math.min(...coordinates.map(([x]) => x)),
		right: Math.max(...coordinates.map(([x]) => x)),
		bottom: Math.min(...coordinates.map(([, y]) => y)),
		top: Math.max(...coordinates.map(([, y]) => y)),
	};
	const squareSize = Math.max(...region.squares.map((square) => square.size));
	const icn = writeIcn(pieces, promotion, worldBorder);
	const reading = { icn, pieces, promotion, worldBorder, shown, area, squareSize, perspective: view.perspective }; // prettier-ignore
	return { reading, covered };
}

/** The board of a screenshot showing nothing else, read whole, unless something shows covering it. */
function openBoard(
	pic: Picture,
	tiles: Tiles,
	views: View[],
	sprites: Sprite[],
): Board | undefined {
	const { view } = chooseView(pic, views.map((view) => ({ view, squares: view.squares })), tiles, sprites); // prettier-ignore
	const sampled = sampleSquares(pic, view.pieces.toImage, view.squares);
	if (isObstructed(sampled, tiles)) return undefined;
	return { view, region: openRegion(sampled, tiles), sampled, obstructed: false };
}

/** The board around whatever covers it: menus, the browser around it, or a photo's foreground. */
function obstructedBoard(pic: Picture, tiles: Tiles, views: View[], sprites: Sprite[]): Board {
	// Bars around the board move the camera's center off the image's.
	if (!tiles.photographed && views[0]!.perspective) views = findViews(pic, tiles, true);
	const candidates: { view: View; squares: Square[]; region: BoardRegion }[] = [];
	let regionError: unknown;
	for (const view of views) {
		try {
			const region = findBoardRegion(pic, view, tiles);
			candidates.push({ view, squares: region.squares, region });
		} catch (error) {
			regionError = error;
		}
	}
	if (candidates.length === 0) throw regionError;
	const { view, region } = chooseView(pic, candidates, tiles, sprites);
	const sampled = sampleSquares(pic, view.pieces.toImage, [...region.squares, ...region.candidates]); // prettier-ignore
	const extent = tiles.photographed ? region.extent : findBoardExtent(sampled, tiles);
	return { view, region: { ...region, extent }, sampled, obstructed: true };
}

/** Of the ways the board might sit, the one its largest pieces fit best standing as drawn. */
function chooseView<T extends { view: View; squares: Square[] }>(
	pic: Picture,
	candidates: T[],
	tiles: Tiles,
	sprites: Sprite[],
): T {
	if (candidates.length === 1) return candidates[0]!;
	const scores = candidates.map(({ view, squares }) => {
		const ordered = [...squares].sort((a, b) => b.size - a.size);
		const stride = Math.max(1, Math.floor(ordered.length / ORIENTATION_SEARCH));
		const largest = ordered
			.filter((_, index) => index % stride === 0)
			.slice(0, ORIENTATION_SEARCH);
		const busy = sampleSquares(pic, view.pieces.toImage, largest)
			.filter((square) => isBusy(square))
			.filter(
				(square) =>
					!tiles.photographed ||
					!isPhotographicBackground(square.patch, square.sizeClass.samples),
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
