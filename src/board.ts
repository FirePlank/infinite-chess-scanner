/**
 * Reads what the board itself shows beyond its pieces: where a world border ends it, which ranks
 * the promotion lines mark, and which way round its coordinates run.
 */

import type { RGB } from './color.js';
import type { Point } from './homography.js';
import type { Picture } from './picture.js';
import type { Promotion, WorldBorder } from './icn.js';
import type { SampledSquare } from './matcher.js';
import type { Tiles } from './tiles.js';
import type { Square, View } from './view.js';

import { colorDistance } from './color.js';
import { project } from './homography.js';
import { innerMask, meanColor } from './matcher.js';
import { colorAt } from './picture.js';
import { isTileColor, projectOntoTiles } from './tiles.js';

// Types -----------------------------------------------------------------------

/** Inclusive ranges of square columns and rows. */
export interface Extent {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/**
 * Maps square columns and rows to board coordinates: the middle square read is 0,0, shifted a
 * file if needed so that dark squares have an even x+y.
 */
export interface Frame {
	midX: number;
	midY: number;
	shift: number;
	/** Whether the screenshot shows black's side, which the site draws rotated 180°. */
	flipped: boolean;
}

// Constants -------------------------------------------------------------------

/** The fraction of a square's samples that must show a tile color for it to lie on the board. */
const BOARD_EVIDENCE = 0.05;

/** How far a pixel on a promotion line lies off the blend of the tile colors, or below the dark one. */
const LINE_TOLERANCE = 0.03;

/** How many squares long a promotion line runs at least. */
const LINE_MIN_SQUARES = 3;

// Coordinates -----------------------------------------------------------------

/** The frame of the squares read, given which parity of column + row the dark tiles sit on. */
export function frameOf(squares: Square[], darkParity: number, flipped: boolean): Frame {
	const extent = extentOf(squares);
	const midX = extent.left + Math.floor((extent.right - extent.left + 1) / 2);
	const midY = extent.top + Math.floor((extent.bottom - extent.top + 1) / 2);
	return { midX, midY, shift: parity(midX + midY) === darkParity ? 0 : 1, flipped };
}

/** The board x of a square column. */
export function fileOf(frame: Frame, column: number): number {
	const x = column - frame.midX + frame.shift;
	return frame.flipped ? -x : x;
}

/** The board y of a square row. */
export function rankOf(frame: Frame, row: number): number {
	const y = frame.midY - row;
	return frame.flipped ? -y : y;
}

/** Which parity of column + row the dark tiles sit on, by majority vote of the squares. */
export function findDarkParity(sampled: SampledSquare[], [dark, light]: Tiles): 0 | 1 {
	let votes = 0;
	for (const { square, sizeClass, patch } of sampled) {
		const mean = meanColor(patch, innerMask(sizeClass.samples));
		const isDark = colorDistance(mean, dark) < colorDistance(mean, light);
		votes += isDark === (parity(square.column + square.row) === 0) ? 1 : -1;
	}
	return votes >= 0 ? 0 : 1;
}

/** Whether a whole number is even (0) or odd (1), negatives included. */
function parity(n: number): 0 | 1 {
	return ((n % 2) + 2) % 2 === 0 ? 0 : 1;
}

// World border ----------------------------------------------------------------

/**
 * The squares a world border leaves on the board: the bounding box of those showing a tile color.
 * @throws If no square does.
 */
export function findBoardExtent(sampled: SampledSquare[], tiles: Tiles): Extent {
	const onBoard = sampled.filter(({ patch }) => showsTile(patch, tiles));
	if (onBoard.length === 0) throw new Error('No board squares found in the image.');
	return extentOf(onBoard.map(({ square }) => square));
}

/** The bounding box of some squares. */
function extentOf(squares: Square[]): Extent {
	const columns = squares.map((square) => square.column);
	const rows = squares.map((square) => square.row);
	return {
		left: Math.min(...columns),
		right: Math.max(...columns),
		top: Math.min(...rows),
		bottom: Math.max(...rows),
	};
}

/** Whether a square lies within an extent. */
export function isWithin(square: Square, extent: Extent): boolean {
	const { column, row } = square;
	return column >= extent.left && column <= extent.right && row >= extent.top && row <= extent.bottom; // prettier-ignore
}

/**
 * Whether enough of a patch's samples show a bare tile color, as only board squares do. Its outer
 * ring counts too, as that's all an obstacle leaves uncovered.
 */
function showsTile(patch: Float32Array, tiles: Tiles): boolean {
	const samples = patch.length / 3;
	let matches = 0;
	for (let p = 0; p < samples; p++) {
		const sample: RGB = [patch[p * 3]!, patch[p * 3 + 1]!, patch[p * 3 + 2]!];
		if (isTileColor(sample, tiles)) matches++;
	}
	return matches >= BOARD_EVIDENCE * samples;
}

/** The world border, on each side where squares read beyond the board show it ending. */
export function readWorldBorder(
	extent: Extent,
	squares: Square[],
	frame: Frame,
): WorldBorder | undefined {
	const beside = (beyond: (square: Square) => boolean, alongRows: boolean): boolean =>
		squares.some((square) => {
			const along = alongRows ? square.row : square.column;
			const [from, to] = alongRows
				? [extent.top, extent.bottom]
				: [extent.left, extent.right];
			return beyond(square) && along >= from && along <= to;
		});
	const onLeft = beside((s) => s.column < extent.left, true) ? fileOf(frame, extent.left) : null;
	const onRight = beside((s) => s.column > extent.right, true) ? fileOf(frame, extent.right) : null; // prettier-ignore
	const onTop = beside((s) => s.row < extent.top, false) ? rankOf(frame, extent.top) : null;
	const onBottom = beside((s) => s.row > extent.bottom, false) ? rankOf(frame, extent.bottom) : null; // prettier-ignore
	const border: WorldBorder = frame.flipped
		? { left: onRight, right: onLeft, bottom: onTop, top: onBottom }
		: { left: onLeft, right: onRight, bottom: onBottom, top: onTop };
	return Object.values(border).some((side) => side !== null) ? border : undefined;
}

// Promotion -------------------------------------------------------------------

/**
 * The row boundaries a promotion line runs along, top first, each as the index of the row below
 * it: pixels off the tile colors' blend between tiles, along several squares.
 */
export function findPromotionLines(
	pic: Picture,
	view: View,
	squares: Square[],
	tiles: Tiles,
): number[] {
	const readable = new Map(squares.map((square) => [`${square.column},${square.row}`, square]));
	const extent = extentOf(squares);
	const lines: number[] = [];
	for (let k = extent.top; k <= extent.bottom + 1; k++) {
		let length = 0;
		for (let column = extent.left; column <= extent.right; column++) {
			const square = readable.get(`${column},${k}`) ?? readable.get(`${column},${k - 1}`);
			if (square) length += lineAlong(pic, view, tiles, column, k, square.size);
		}
		if (length >= LINE_MIN_SQUARES) lines.push(k);
	}
	return lines;
}

/** How much of the boundary atop row k in a column a line runs along, in squares. */
function lineAlong(
	pic: Picture,
	view: View,
	tiles: Tiles,
	column: number,
	k: number,
	size: number,
): number {
	const reach = Math.max(2, Math.floor(size / 4));
	const steps = Math.max(1, Math.ceil(size));
	let length = 0;
	for (let i = 0; i < steps; i++) {
		const u = column + (i + 0.5) / steps;
		const on = project(view.toImage, u, k);
		const next = project(view.toImage, u, k + 0.01);
		const across = Math.hypot(next[0] - on[0], next[1] - on[1]);
		const normal: Point = [(next[0] - on[0]) / across, (next[1] - on[1]) / across];
		const at = (distance: number): Point => [on[0] + distance * normal[0], on[1] + distance * normal[1]]; // prettier-ignore
		if (!isTileAt(pic, at(-reach), tiles) || !isTileAt(pic, at(reach), tiles)) continue;
		if (isLineAt(pic, at(-0.5), tiles) || isLineAt(pic, at(0.5), tiles)) length += 1 / steps;
	}
	return length;
}

/** The index of the pixel holding a point, if the image does. */
function pixelAt(pic: Picture, [x, y]: Point): number | undefined {
	const [px, py] = [Math.floor(x), Math.floor(y)];
	if (px < 0 || py < 0 || px >= pic.width || py >= pic.height) return undefined;
	return py * pic.width + px;
}

/** Whether the pixel at a point is a tile color. */
function isTileAt(pic: Picture, point: Point, tiles: Tiles): boolean {
	const i = pixelAt(pic, point);
	return i !== undefined && isTileColor(colorAt(pic, i), tiles);
}

/** Whether the pixel at a point lies off the blend of the tile colors, or darker than it, as on a line drawn over them. */
function isLineAt(pic: Picture, point: Point, tiles: Tiles): boolean {
	const i = pixelAt(pic, point);
	if (i === undefined) return false;
	const [t, off] = projectOntoTiles(pic, i, tiles);
	return off > LINE_TOLERANCE || t * colorDistance(tiles[0], tiles[1]) < -LINE_TOLERANCE;
}

/**
 * The promotion ranks from the promotion lines. Each side's lines run along the far edge of its
 * ranks, on the far half of the board, so the upper lines on screen hold the rows below them. An
 * odd count can't be split.
 */
export function readPromotion(lines: number[], frame: Frame): Promotion | undefined {
	if (lines.length === 0 || lines.length % 2 !== 0) return undefined;
	const half = lines.length / 2;
	const upper = lines.slice(0, half).map((row) => rankOf(frame, row));
	const lower = lines.slice(half).map((row) => rankOf(frame, row - 1));
	return frame.flipped ? { white: lower, black: upper } : { white: upper, black: lower };
}
