/**
 * Finds the board's two tile colors, and tells how any pixel relates to them.
 */

import type { RGB } from './color.js';
import type { Picture } from './picture.js';

import { colorDistance, luminance } from './color.js';

// Types -----------------------------------------------------------------------

/** The board's tile colors, the dark one first. */
export type Tiles = [dark: RGB, light: RGB];

// Constants -------------------------------------------------------------------

/** How close a color must be to a tile color to count as one. */
const TILE_TOLERANCE = 0.05;

/**
 * Pixel offsets before and after a checkerboard corner. Immediate neighbors fit beside small
 * obstacles; wider stencils clear blurred tile edges.
 */
const CORNER_REACHES = [
	[1, 0],
	[1, 1],
	[2, 2],
] as const;

/** How many color histogram bins there are, at 6 bits per channel. */
const BIN_COUNT = 1 << 18;

// Functions -------------------------------------------------------------------

/**
 * The tile colors: the color pair meeting most often at checkerboard corners, where diagonally
 * opposite squares match and neighboring ones differ. Nothing but a checkerboard draws that, so
 * the sky around a world border can't be mistaken for it.
 * @throws If there's no checkerboard.
 */
export function findTileColors(pic: Picture): Tiles {
	const { width, height } = pic;
	const bins = new Uint32Array(width * height);
	for (let i = 0; i < bins.length; i++) bins[i] = binOf(pic.rgb, i);

	const votes = new Map<number, number>();
	for (const reach of CORNER_REACHES) countCorners(bins, width, height, reach, votes);

	let best: number | undefined;
	for (const [pair, count] of votes) {
		const [a, b] = [Math.floor(pair / BIN_COUNT), pair % BIN_COUNT];
		const distinct = colorDistance(binColor(a), binColor(b)) > 0.06;
		if (distinct && (best === undefined || count > votes.get(best)!)) best = pair;
	}
	if (best === undefined) throw new Error('No checkerboard with readable squares found in the image.'); // prettier-ignore
	const tiles = meansOfBins(pic, bins, Math.floor(best / BIN_COUNT), best % BIN_COUNT);
	tiles.sort((a, b) => luminance(a) - luminance(b));
	return [tiles[0], tiles[1]];
}

/** Tallies the color bin pairs meeting at checkerboard corners, read a reach away from each. */
function countCorners(
	bins: Uint32Array,
	width: number,
	height: number,
	reach: readonly [number, number],
	votes: Map<number, number>,
): void {
	const [before, after] = reach;
	for (let y = before; y < height - after; y++) {
		for (let x = before; x < width - after; x++) {
			const a = bins[(y - before) * width + x - before]!;
			const b = bins[(y - before) * width + x + after]!;
			if (a === b || bins[(y + after) * width + x + after] !== a) continue;
			if (bins[(y + after) * width + x - before] !== b) continue;
			const pair = Math.min(a, b) * BIN_COUNT + Math.max(a, b);
			votes.set(pair, (votes.get(pair) ?? 0) + 1);
		}
	}
}

/** The 6-bit-per-channel color histogram bin of pixel i. */
function binOf(rgb: Float32Array, i: number): number {
	const r = ((rgb[i * 3]! * 255 + 0.5) | 0) >> 2;
	const g = ((rgb[i * 3 + 1]! * 255 + 0.5) | 0) >> 2;
	const b = ((rgb[i * 3 + 2]! * 255 + 0.5) | 0) >> 2;
	return (r << 12) | (g << 6) | b;
}

/** The center color of a histogram bin. */
function binColor(bin: number): RGB {
	return [((bin >> 12) + 0.5) / 64, (((bin >> 6) & 63) + 0.5) / 64, ((bin & 63) + 0.5) / 64];
}

/** The exact mean colors of the pixels in two histogram bins. */
function meansOfBins(pic: Picture, bins: Uint32Array, first: number, second: number): [RGB, RGB] {
	const sums = [new Float64Array(4), new Float64Array(4)] as const;
	for (let i = 0; i < bins.length; i++) {
		const sum = bins[i] === first ? sums[0] : bins[i] === second ? sums[1] : undefined;
		if (sum === undefined) continue;
		for (let c = 0; c < 3; c++) sum[c]! += pic.rgb[i * 3 + c]!;
		sum[3]!++;
	}
	const mean = (sum: Float64Array): RGB => [
		sum[0]! / sum[3]!,
		sum[1]! / sum[3]!,
		sum[2]! / sum[3]!,
	];
	return [mean(sums[0]), mean(sums[1])];
}

/** Whether a color is one of the tile colors. */
export function isTileColor(color: RGB, [dark, light]: Tiles): boolean {
	return (
		colorDistance(color, dark) < TILE_TOLERANCE || colorDistance(color, light) < TILE_TOLERANCE
	);
}

/** Each pixel's position from the dark (0) to the light (1) tile color, or NaN if it's neither. */
export function tileShades(pic: Picture, [dark, light]: Tiles): Float32Array {
	const [ar, ag, ab] = [light[0] - dark[0], light[1] - dark[1], light[2] - dark[2]];
	const lengthSq = ar * ar + ag * ag + ab * ab;
	const tolerance = 0.25 * Math.sqrt(lengthSq) + 0.02;
	const shades = new Float32Array(pic.width * pic.height);
	for (let i = 0; i < shades.length; i++) {
		const r = pic.rgb[i * 3]! - dark[0];
		const g = pic.rgb[i * 3 + 1]! - dark[1];
		const b = pic.rgb[i * 3 + 2]! - dark[2];
		const t = (r * ar + g * ag + b * ab) / lengthSq;
		const offR = r - t * ar;
		const offG = g - t * ag;
		const offB = b - t * ab;
		const off = Math.sqrt(offR * offR + offG * offG + offB * offB);
		shades[i] = off < tolerance && t > -0.25 && t < 1.25 ? t : NaN;
	}
	return shades;
}

/**
 * Where pixel i lies against the blend from the dark to the light tile color: how far along it,
 * from 0 at dark to 1 at light, and how far off it.
 */
export function projectOntoTiles(pic: Picture, i: number, [dark, light]: Tiles): [number, number] {
	const axis: RGB = [light[0] - dark[0], light[1] - dark[1], light[2] - dark[2]];
	const r = pic.rgb[i * 3]! - dark[0];
	const g = pic.rgb[i * 3 + 1]! - dark[1];
	const b = pic.rgb[i * 3 + 2]! - dark[2];
	const t =
		(r * axis[0] + g * axis[1] + b * axis[2]) / (axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2);
	return [t, Math.hypot(r - t * axis[0], g - t * axis[1], b - t * axis[2])];
}
