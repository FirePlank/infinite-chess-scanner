/**
 * Reads what the board itself shows beyond its pieces: where a world border ends it, which ranks
 * the promotion lines mark, and which way round its coordinates run.
 */

import type { RGB } from './color.js';
import type { Grid } from './grid.js';
import type { Picture } from './picture.js';
import type { Promotion, WorldBorder } from './icn.js';
import type { Tiles } from './tiles.js';

import { colorDistance } from './color.js';
import { meanColor } from './matcher.js';
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
 * Maps square columns and rows to board coordinates: the middle square is 0,0, shifted a file
 * if needed so that dark squares have an even x+y.
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

/** The frame of a grid, given which parity of column + row the dark tiles sit on. */
export function frameOf(grid: Grid, darkParity: number, flipped: boolean): Frame {
	const midX = Math.floor(grid.x.count / 2);
	const midY = Math.floor(grid.y.count / 2);
	return { midX, midY, shift: (midX + midY) % 2 === darkParity ? 0 : 1, flipped };
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
export function findDarkParity(
	patches: Float32Array[][],
	[dark, light]: Tiles,
	mask: Uint8Array,
): 0 | 1 {
	let votes = 0;
	patches.forEach((line, row) =>
		line.forEach((patch, column) => {
			const mean = meanColor(patch, mask);
			const isDark = colorDistance(mean, dark) < colorDistance(mean, light);
			votes += isDark === ((column + row) % 2 === 0) ? 1 : -1;
		}),
	);
	return votes >= 0 ? 0 : 1;
}

// World border ----------------------------------------------------------------

/**
 * The squares a world border leaves on the board: the bounding box of those showing a tile color.
 * @throws If no square does.
 */
export function findBoardExtent(patches: Float32Array[][], tiles: Tiles): Extent {
	const extent: Extent = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
	patches.forEach((line, row) =>
		line.forEach((patch, column) => {
			if (!showsTile(patch, tiles)) return;
			extent.left = Math.min(extent.left, column);
			extent.right = Math.max(extent.right, column);
			extent.top = Math.min(extent.top, row);
			extent.bottom = Math.max(extent.bottom, row);
		}),
	);
	if (extent.left === Infinity) throw new Error('No board squares found in the image.');
	return extent;
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

/** The world border, on the sides where the board stops short of the image edge. */
export function readWorldBorder(extent: Extent, grid: Grid, frame: Frame): WorldBorder | undefined {
	const onLeft = extent.left > 0 ? fileOf(frame, extent.left) : null;
	const onRight = extent.right < grid.x.count - 1 ? fileOf(frame, extent.right) : null;
	const onBottom = extent.bottom < grid.y.count - 1 ? rankOf(frame, extent.bottom) : null;
	const onTop = extent.top > 0 ? rankOf(frame, extent.top) : null;
	const border: WorldBorder = frame.flipped
		? { left: onRight, right: onLeft, bottom: onTop, top: onBottom }
		: { left: onLeft, right: onRight, bottom: onBottom, top: onTop };
	return Object.values(border).some((side) => side !== null) ? border : undefined;
}

// Promotion -------------------------------------------------------------------

/**
 * The row boundaries a promotion line runs along, top first, each as the index of the row below
 * it: rows of pixels off the tile colors' blend between tiles, for several squares.
 */
export function findPromotionLines(pic: Picture, grid: Grid, tiles: Tiles): number[] {
	const reach = Math.max(2, Math.floor(grid.size / 4));
	const lines: number[] = [];
	for (let k = 0; k <= grid.y.count; k++) {
		const y = grid.y.origin + k * grid.size;
		const above = Math.floor(y - reach);
		const below = Math.floor(y + reach);
		if (above < 0 || below >= pic.height) continue;
		let length = 0;
		for (let x = 0; x < pic.width; x++) {
			if (!isTileAt(pic, x, above, tiles) || !isTileAt(pic, x, below, tiles)) continue;
			const onLine =
				isLineAt(pic, x, Math.floor(y - 0.5), tiles) ||
				isLineAt(pic, x, Math.floor(y + 0.5), tiles);
			if (onLine) length++;
		}
		if (length >= LINE_MIN_SQUARES * grid.size) lines.push(k);
	}
	return lines;
}

/** Whether a pixel is a tile color. */
function isTileAt(pic: Picture, x: number, y: number, tiles: Tiles): boolean {
	return isTileColor(colorAt(pic, y * pic.width + x), tiles);
}

/** Whether a pixel lies off the blend of the tile colors, or darker than it, as on a line drawn over them. */
function isLineAt(pic: Picture, x: number, y: number, tiles: Tiles): boolean {
	const [t, off] = projectOntoTiles(pic, y * pic.width + x, tiles);
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
