/**
 * Reads what the board itself shows beyond its pieces: where a world border ends it, which ranks
 * the promotion lines mark, and which way round its coordinates run.
 */

import type { RGB } from './color.js';
import type { Picture } from './picture.js';
import type { Promotion, WorldBorder } from './icn.js';
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
	if (tiles.photographed) return photographPromotionLines(pic, view, squares);
	const readable = new Map(squares.map((square) => [square.column + ',' + square.row, square]));
	const extent = extentOf(squares);
	const lines: number[] = [];
	for (let row = extent.top; row <= extent.bottom + 1; row++) {
		let length = 0;
		for (let column = extent.left; column <= extent.right; column++) {
			const square =
				readable.get(column + ',' + row) ?? readable.get(column + ',' + (row - 1));
			if (square) length += lineAlong(pic, view, tiles, column, row, square.size);
		}
		if (length >= LINE_MIN_SQUARES) lines.push(row);
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

interface BoundaryProfile {
	before: RGB;
	after: RGB;
	colors: RGB[];
}

interface BoundaryStrip {
	noise: number;
	sidebands: RGB[];
	residuals: RGB[];
}

interface BoundaryCell extends BoundaryStrip {
	column: number;
}

interface BoundaryRow {
	row: number;
	cells: BoundaryCell[];
}

/**
 * A camera line is a coherent RGB departure from the local tile transition. Each row uses one
 * bounded image phase across its cells, rather than independently picking every strip's darkest
 * camera stripe. Off-boundary strips estimate the noise; separated probes and cells establish the
 * line's persistence. Gray, colored and nearly equal tile colors use this same observation model.
 */
function photographPromotionLines(pic: Picture, view: View, squares: Square[]): number[] {
	const readable = new Map(squares.map((square) => [square.column + ',' + square.row, square]));
	const extent = extentOf(squares);
	const evidence: { row: number; confidence: number }[] = [];
	const rows: BoundaryRow[] = [];
	for (let row = extent.top; row <= extent.bottom + 1; row++) {
		const cells = boundaryCells(pic, view, readable, extent, row);
		if (cells.length >= LINE_MIN_SQUARES) rows.push({ row, cells });
	}
	// Ordinary checker transitions calibrate the RGB fringe noise near each candidate row.
	// Leave the candidate out so its drawn line cannot set its own significance threshold.
	for (const { row, cells } of rows) {
		const nearby = rows.filter((other) => other.row !== row && Math.abs(other.row - row) <= 3);
		for (const cell of cells) {
			const local = (
				nearby.length ? nearby : rows.filter((other) => other.row !== row)
			).flatMap(({ cells }) =>
				cells.filter((other) => Math.abs(other.column - cell.column) <= 1),
			);
			if (local.length === 0) continue;
			const transitionNoise = Math.max(
				0.003,
				median(
					local.flatMap(({ residuals }) =>
						residuals.map((residual) => Math.hypot(...residual) / Math.sqrt(3)),
					),
				) / 1.5,
			);
			cell.noise = Math.max(cell.noise, transitionNoise);
		}
		const confidence = boundaryConfidence(cells);
		if (confidence > 0) evidence.push({ row, confidence });
	}
	// Both players contribute the same number of ranks. An unpaired weak ridge is more likely
	// camera noise; retain the even set with the greatest total independent boundary evidence.
	if (evidence.length % 2 !== 0) {
		let weakest = 0;
		for (let i = 1; i < evidence.length; i++)
			if (evidence[i]!.confidence < evidence[weakest]!.confidence) weakest = i;
		evidence.splice(weakest, 1);
	}
	return evidence.map(({ row }) => row);
}

/** The independent strip observations retained for a row of exposed neighboring checker tiles. */
function boundaryCells(
	pic: Picture,
	view: View,
	readable: ReadonlyMap<string, Square>,
	extent: Extent,
	row: number,
): BoundaryCell[] {
	const observed = new Map<number, { profiles: (BoundaryProfile | undefined)[] }>();
	for (let column = extent.left; column <= extent.right; column++) {
		const square = readable.get(column + ',' + row) ?? readable.get(column + ',' + (row - 1));
		if (!square) continue;
		observed.set(column, {
			profiles: [0.25, 0.5, 0.75].map((part) =>
				boundaryProfile(pic, view, column + part, row, square.size),
			),
		});
	}
	const cells: BoundaryCell[] = [];
	for (const [column, { profiles }] of observed) {
		const probes: BoundaryStrip[] = [];
		for (let part = 0; part < profiles.length; part++) {
			const profile = profiles[part];
			if (!profile) continue;
			const contrast = colorDistance(profile.before, profile.after);
			const compatible = [-1, 1].some((direction) => {
				const adjacent = observed.get(column + direction)?.profiles[part];
				if (!adjacent) return false;
				const alternating = Math.max(
					colorDistance(profile.before, adjacent.after),
					colorDistance(profile.after, adjacent.before),
				);
				const uniform = Math.max(
					contrast,
					colorDistance(profile.before, adjacent.before),
					colorDistance(profile.after, adjacent.after),
				);
				return Math.min(alternating, uniform) < Math.max(0.07, 0.65 * contrast);
			});
			if (!compatible) continue;
			const flank = 2 + 2 * Math.min(1, contrast / 0.12);
			const residual = (shift: number): RGB => boundaryResidual(profile, shift, flank);
			// These sidebands exclude the fitted boundary and retain broad as well as fine moire.
			const sidebands = [-10, -9, -8, -7, -6, -5, 5, 6, 7, 8, 9, 10].map(residual);
			const noise = Math.max(
				0.003,
				median(sidebands.map((value) => Math.hypot(...value) / Math.sqrt(3))) / 1.5,
			);
			const residuals: RGB[] = [];
			for (let shift = -3; shift <= 3; shift += 0.5) residuals.push(residual(shift));
			probes.push({ noise, residuals, sidebands });
		}
		if (probes.length < 2) continue;
		cells.push({
			column,
			noise: median(probes.map((probe) => probe.noise)),
			sidebands: probes[0]!.sidebands.map(
				(_, phase) =>
					[0, 1, 2].map((channel) =>
						median(probes.map((probe) => probe.sidebands[phase]![channel]!)),
					) as RGB,
			),
			residuals: probes[0]!.residuals.map(
				(_, phase) =>
					[0, 1, 2].map((channel) =>
						median(probes.map((probe) => probe.residuals[phase]![channel]!)),
					) as RGB,
			),
		});
	}
	return cells;
}

/** The strongest boundary-locked RGB ridge, evaluated at a single phase for the whole row. */
function boundaryConfidence(cells: BoundaryCell[]): number {
	// Equal cell contributions let differently phased RGB fringes cancel instead of favoring quiet dips.
	let confidence = 0;
	for (let phase = 0; phase < 13; phase++) {
		const mean: RGB = [0, 0, 0];
		let supported = 0;
		for (const cell of cells) {
			const residual = cell.residuals[phase]!;
			for (let channel = 0; channel < 3; channel++) mean[channel]! += residual[channel]!;
			if (
				-luminance(residual) > 0.02 &&
				Math.hypot(...residual) / Math.sqrt(3) > 2.5 * cell.noise
			)
				supported++;
		}
		for (let channel = 0; channel < 3; channel++) mean[channel]! /= cells.length;
		// Keep the noise of a whole strip: its pixels and neighboring cells are correlated.
		const noise = median(cells.map((cell) => cell.noise));
		const amplitude = Math.hypot(...mean);
		const repeated = cells[0]!.sidebands.map((_, offset) => {
			let projection = 0;
			for (const cell of cells)
				projection += cell.sidebands[offset]!.reduce(
					(sum, value, channel) => sum + value * mean[channel]!,
					0,
				);
			return projection / cells.length / Math.max(1e-9, amplitude);
		});
		const sidePeak = Math.max(...repeated);
		if (
			supported >= LINE_MIN_SQUARES &&
			luminance(mean) < 0 &&
			amplitude / Math.sqrt(3) > noise &&
			amplitude > sidePeak
		) {
			confidence = Math.max(confidence, (amplitude - sidePeak) / noise);
		}
	}
	return confidence;
}

/** A continuous, along-boundary strip profile in camera pixels, centered on the fitted grid. */
function boundaryProfile(
	pic: Picture,
	view: View,
	u: number,
	row: number,
	size: number,
): BoundaryProfile | undefined {
	const [x, y] = project(view.toImage, u, row);
	const [alongX, alongY] = project(view.toImage, u + 0.01, row);
	const [acrossX, acrossY] = project(view.toImage, u, row + 0.01);
	const along = Math.hypot(alongX - x, alongY - y);
	const across = Math.hypot(acrossX - x, acrossY - y);
	const [tx, ty] = [(alongX - x) / along, (alongY - y) / along];
	const [nx, ny] = [(acrossX - x) / across, (acrossY - y) / across];
	const at = (shift: number): RGB | undefined =>
		averagedAt(pic, x + shift * nx, y + shift * ny, tx, ty, 8);
	const before = at(-size / 4);
	const after = at(size / 4);
	if (!before || !after) return undefined;
	const colors: RGB[] = [];
	for (let shift = -14; shift <= 14; shift += 0.5) {
		const color = at(shift);
		if (!color) return undefined;
		colors.push(color);
	}
	return { before, after, colors };
}

/** The RGB component a narrow profile cannot explain as a blend of its neighboring flanks. */
function boundaryResidual(profile: BoundaryProfile, shift: number, flank: number): RGB {
	const at = (offset: number): RGB => {
		const index = (offset + 14) * 2;
		const low = Math.floor(index);
		const fraction = index - low;
		return [0, 1, 2].map(
			(channel) =>
				profile.colors[low]![channel]! * (1 - fraction) +
				profile.colors[Math.min(low + 1, profile.colors.length - 1)]![channel]! * fraction,
		) as RGB;
	};
	const color = at(shift),
		before = at(shift - flank),
		after = at(shift + flank);
	const axis = after.map((value, channel) => value - before[channel]!) as RGB;
	const squared = axis.reduce((sum, value) => sum + value * value, 0);
	const dot = axis.reduce(
		(sum, value, channel) => sum + value * (color[channel]! - before[channel]!),
		0,
	);
	const blend = Math.max(0, Math.min(1, dot / Math.max(1e-9, squared)));
	return color.map((value, channel) => value - before[channel]! - blend * axis[channel]!) as RGB;
}

function median(values: number[]): number {
	values.sort((a, b) => a - b);
	return values[Math.floor(values.length / 2)]!;
}

/** Bilinear strip sampling avoids discontinuous evidence when the grid moves a fraction of a pixel. */
function averagedAt(
	pic: Picture,
	x: number,
	y: number,
	tx: number,
	ty: number,
	radius: number,
): RGB | undefined {
	const mean: RGB = [0, 0, 0];
	const samples = 2 * radius + 1;
	for (let step = -radius; step <= radius; step++) {
		const px = x + step * tx - 0.5,
			py = y + step * ty - 0.5;
		const ix = Math.floor(px),
			iy = Math.floor(py);
		if (ix < 0 || iy < 0 || ix + 1 >= pic.width || iy + 1 >= pic.height) return undefined;
		const fx = px - ix,
			fy = py - iy;
		const at = (iy * pic.width + ix) * 3;
		for (let channel = 0; channel < 3; channel++) {
			mean[channel]! +=
				(pic.rgb[at + channel]! * (1 - fx) * (1 - fy) +
					pic.rgb[at + 3 + channel]! * fx * (1 - fy) +
					pic.rgb[at + pic.width * 3 + channel]! * (1 - fx) * fy +
					pic.rgb[at + (pic.width + 1) * 3 + channel]! * fx * fy) /
				samples;
		}
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
