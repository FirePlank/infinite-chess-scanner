/**
 * Reads what the board itself shows beyond its pieces: where a world border ends it, which ranks
 * the promotion lines mark, and which way round its coordinates run.
 */

import type { RGB } from './color.js';
import type { Picture } from './picture.js';
import type { PlacedPiece, Promotion, WorldBorder } from './icn.js';
import type { SampledSquare } from './matcher.js';
import type { Tiles } from './tiles.js';
import type { Square, View } from './view.js';

import { colorDistance, luminance } from './color.js';
import { project } from './homography.js';
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
 * Maps square columns and rows to board coordinates, with an even x+y on dark squares.
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

/**
 * Anchors a read position at positive files and, with one promotion rank per side, Black's rank
 * at y=1. The leftmost piece sits at x=1 or x=2 so the translation preserves square colors.
 */
export function anchorFrame(
	frame: Frame,
	pieces: PlacedPiece[],
	promotion: Promotion | undefined,
): Frame {
	const dy =
		promotion?.white.length === 1 && promotion.black.length === 1 ? 1 - promotion.black[0]! : 0;
	let dx = pieces.length > 0 ? 1 - Math.min(...pieces.map((piece) => piece.x)) : 0;
	dx += parity(dx + dy);
	const direction = frame.flipped ? -1 : 1;
	return { ...frame, midX: frame.midX - direction * dx, midY: frame.midY + direction * dy };
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
	for (const { square, mean } of sampled) {
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
	const onBoard = sampled.filter(({ patch, mean }) => (patch ? showsTile(patch, tiles) : isTileColor(mean, tiles))); // prettier-ignore
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
	if (tiles.photographed) return photographedLineAlong(pic, view, column, k, size);
	const reach = Math.max(2, Math.floor(size / 4));
	const steps = Math.max(1, Math.ceil(size));
	let length = 0;
	for (let i = 0; i < steps; i++) {
		const u = column + (i + 0.5) / steps;
		const [x, y] = project(view.toImage, u, k);
		const [nextX, nextY] = project(view.toImage, u, k + 0.01);
		const across = Math.sqrt((nextX - x) ** 2 + (nextY - y) ** 2);
		const [nx, ny] = [(nextX - x) / across, (nextY - y) / across];
		if (!isTileAt(pic, x - reach * nx, y - reach * ny, tiles)) continue;
		if (!isTileAt(pic, x + reach * nx, y + reach * ny, tiles)) continue;
		const onLine = isLineAt(pic, x - 0.5 * nx, y - 0.5 * ny, tiles) || isLineAt(pic, x + 0.5 * nx, y + 0.5 * ny, tiles); // prettier-ignore
		if (onLine) length += 1 / steps;
	}
	return length;
}

/**
 * Camera exposure and display stripes vary across a photograph. Compare a thin line with the
 * adjacent tiles at the same location, averaging along it to suppress the display's pixel pattern.
 */
function photographedLineAlong(
	pic: Picture,
	view: View,
	column: number,
	k: number,
	size: number,
): number {
	const reach = Math.max(3, size / 4);
	const steps = Math.max(1, Math.ceil(size));
	let length = 0;
	for (let i = 0; i < steps; i++) {
		const u = column + (i + 0.5) / steps;
		const [x, y] = project(view.toImage, u, k);
		const [nextX, nextY] = project(view.toImage, u, k + 0.01);
		const across = Math.hypot(nextX - x, nextY - y);
		const [nx, ny] = [(nextX - x) / across, (nextY - y) / across];
		const [alongX, alongY] = project(view.toImage, u + 0.01, k);
		const along = Math.hypot(alongX - x, alongY - y);
		const [tx, ty] = [(alongX - x) / along, (alongY - y) / along];
		const before = averagedAt(pic, x - reach * nx, y - reach * ny, tx, ty);
		const after = averagedAt(pic, x + reach * nx, y + reach * ny, tx, ty);
		if (!before || !after || colorDistance(before, after) < 0.12) continue;
		// Both sides must keep alternating in the adjacent column. This excludes a UI edge
		// meeting the board, even when its gray happens to resemble one tile color.
		let alternates = false;
		for (const direction of [-1, 1]) {
			const [adjacentX, adjacentY] = project(view.toImage, u + direction, k);
			const adjacentBefore = averagedAt(
				pic,
				adjacentX - reach * nx,
				adjacentY - reach * ny,
				tx,
				ty,
			);
			const adjacentAfter = averagedAt(
				pic,
				adjacentX + reach * nx,
				adjacentY + reach * ny,
				tx,
				ty,
			);
			if (adjacentBefore && adjacentAfter && colorDistance(before, adjacentAfter) < 0.15 && colorDistance(after, adjacentBefore) < 0.15) alternates = true; // prettier-ignore
		}
		if (!alternates) continue;
		const dark = Math.min(luminance(before), luminance(after));
		let onLine = false;
		for (let shift = -2; shift <= 2; shift += 0.5) {
			const color = averagedAt(pic, x + shift * nx, y + shift * ny, tx, ty);
			if (color && luminance(color) < dark - 0.07) onLine = true;
		}
		if (onLine) length += 1 / steps;
	}
	// Display stripes can leave isolated dark samples. A drawn line persists through most of a tile.
	return length >= 0.5 ? length : 0;
}

/** The mean color of a short strip in a direction, or absent if it leaves the image. */
function averagedAt(pic: Picture, x: number, y: number, tx: number, ty: number): RGB | undefined {
	const mean: RGB = [0, 0, 0];
	for (let step = -2; step <= 2; step++) {
		const pixel = pixelAt(pic, x + step * tx, y + step * ty);
		if (pixel < 0) return undefined;
		const color = colorAt(pic, pixel);
		for (let channel = 0; channel < 3; channel++) mean[channel]! += color[channel]! / 5;
	}
	return mean;
}

/** The index of the pixel holding a point, or -1 if the image doesn't. */
function pixelAt(pic: Picture, x: number, y: number): number {
	const [px, py] = [Math.floor(x), Math.floor(y)];
	if (px < 0 || py < 0 || px >= pic.width || py >= pic.height) return -1;
	return py * pic.width + px;
}

/** Whether the pixel at a point is a tile color. */
function isTileAt(pic: Picture, x: number, y: number, tiles: Tiles): boolean {
	const i = pixelAt(pic, x, y);
	return i >= 0 && isTileColor(colorAt(pic, i), tiles);
}

/** Whether the pixel at a point lies off the blend of the tile colors, or darker than it, as on a line drawn over them. */
function isLineAt(pic: Picture, x: number, y: number, tiles: Tiles): boolean {
	const i = pixelAt(pic, x, y);
	if (i < 0) return false;
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
