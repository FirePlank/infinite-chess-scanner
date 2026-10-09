/**
 * Finds the board's two tile colors, and tells how any pixel relates to them.
 */

import type { RGB } from './color.js';
import type { Picture } from './picture.js';

import { colorDistance, luminance } from './color.js';

// Types -----------------------------------------------------------------------

/** The board's tile colors, the dark one first. */
export type Tiles = [dark: RGB, light: RGB] & {
	/** Whether colors were recovered by averaging a camera's display noise. */
	photographed?: true;
};

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
	// A photographed display has repeated subpixel stripes of its own. Their tiny contrast can
	// win exact-color votes, so average over the stripes before looking for the board's colors.
	if (colorDistance(tiles[0], tiles[1]) < 0.15 && hasDisplayNoise(pic)) {
		const averaged = averagedTileColors(pic);
		if (averaged) return averaged;
	}
	tiles.sort((a, b) => luminance(a) - luminance(b));
	return [tiles[0], tiles[1]];
}

/** Flat screenshot areas repeat exact pixels; a camera's display stripes vary almost everywhere. */
function hasDisplayNoise(pic: Picture): boolean {
	let same = 0;
	let total = 0;
	for (let i = 0; i < pic.width * pic.height - 1; i += 11) {
		if (i % pic.width === pic.width - 1) continue;
		total++;
		if (pic.rgb[i * 3] === pic.rgb[(i + 1) * 3] && pic.rgb[i * 3 + 1] === pic.rgb[(i + 1) * 3 + 1] && pic.rgb[i * 3 + 2] === pic.rgb[(i + 1) * 3 + 2]) same++; // prettier-ignore
	}
	return same < 0.35 * total;
}

/** Checkerboard color votes from small averaged patches, at both axis and diagonal corners. */
function averagedTileColors(pic: Picture): Tiles | undefined {
	const votes = new Map<number, { count: number; sums: number[]; reaches: Set<number> }>();
	const { width, height, sat } = pic;
	const stride = (width + 1) * 3;
	const mean = (x: number, y: number): RGB => {
		const a = (y - 2) * stride + (x - 2) * 3;
		const b = a + 15;
		const c = a + 5 * stride;
		const d = c + 15;
		return [0, 1, 2].map((channel) => (sat[d + channel]! - sat[b + channel]! - sat[c + channel]! + sat[a + channel]!) / 25) as RGB; // prettier-ignore
	};
	const bin = (color: RGB): number => color.reduce((n, value) => n * 16 + Math.min(15, Math.floor(value * 16)), 0); // prettier-ignore
	for (const reach of [4, 7]) {
		for (const diagonal of [true, false]) {
			for (let y = reach + 2; y < height - reach - 2; y += 2) {
				for (let x = reach + 2; x < width - reach - 2; x += 2) {
					const colors = diagonal
						? [
								mean(x - reach, y - reach),
								mean(x + reach, y - reach),
								mean(x + reach, y + reach),
								mean(x - reach, y + reach),
							]
						: [
								mean(x - reach, y),
								mean(x, y - reach),
								mean(x + reach, y),
								mean(x, y + reach),
							];
					const [a, b, c, d] = colors as [RGB, RGB, RGB, RGB];
					if (colorDistance(a, c) > 0.06 || colorDistance(b, d) > 0.06 || colorDistance(a, b) < 0.15) continue; // prettier-ignore
					let first = a.map((value, channel) => (value + c[channel]!) / 2) as RGB;
					let second = b.map((value, channel) => (value + d[channel]!) / 2) as RGB;
					if (luminance(first) > luminance(second)) [first, second] = [second, first];
					const key = bin(first) * 4096 + bin(second);
					const vote = votes.get(key) ?? { count: 0, sums: [0, 0, 0, 0, 0, 0], reaches: new Set<number>() }; // prettier-ignore
					vote.count++;
					vote.reaches.add(reach);
					for (let channel = 0; channel < 3; channel++) {
						vote.sums[channel]! += first[channel]!;
						vote.sums[channel + 3]! += second[channel]!;
					}
					votes.set(key, vote);
				}
			}
		}
	}
	const best = [...votes.values()].sort((a, b) => b.count - a.count)[0];
	// Small repeating obstacles can alternate at one reach. The same tile colors must meet at
	// both reaches to distinguish broad checkerboard squares from those repeated marks.
	if (!best || best.count < 12 || best.reaches.size < 2) return undefined;
	const tiles: Tiles = [best.sums.slice(0, 3).map((value) => value / best.count) as RGB, best.sums.slice(3).map((value) => value / best.count) as RGB]; // prettier-ignore
	tiles.photographed = true;
	return tiles;
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

/** Whether a plain square's color is a void's, or the sky's beyond a world border: darker than the dark tile. */
export function isVoidColor(color: RGB, [dark]: Tiles): boolean {
	return colorDistance(color, dark) > 0.08 && luminance(color) < 0.8 * luminance(dark);
}

/** Each pixel's position from the dark (0) to the light (1) tile color, or NaN if it's neither. */
export function tileShades(pic: Picture, tiles: Tiles): Float32Array {
	const [dark, light] = tiles;
	const [ar, ag, ab] = [light[0] - dark[0], light[1] - dark[1], light[2] - dark[2]];
	const lengthSq = ar * ar + ag * ag + ab * ab;
	const tolerance = 0.25 * Math.sqrt(lengthSq) + 0.02;
	const shades = new Float32Array(pic.width * pic.height);
	for (let i = 0; i < shades.length; i++) {
		let r = pic.rgb[i * 3]! - dark[0];
		let g = pic.rgb[i * 3 + 1]! - dark[1];
		let b = pic.rgb[i * 3 + 2]! - dark[2];
		if (tiles.photographed) {
			const x = i % pic.width;
			const y = (i - x) / pic.width;
			const [x0, y0, x1, y1] = [Math.max(0, x - 3), Math.max(0, y - 3), Math.min(pic.width, x + 4), Math.min(pic.height, y + 4)]; // prettier-ignore
			const stride = pic.width + 1;
			const area = (x1 - x0) * (y1 - y0);
			const [a, d, c, e] = [(y1 * stride + x1) * 3, (y0 * stride + x1) * 3, (y1 * stride + x0) * 3, (y0 * stride + x0) * 3]; // prettier-ignore
			r = (pic.sat[a]! - pic.sat[d]! - pic.sat[c]! + pic.sat[e]!) / area - dark[0];
			g = (pic.sat[a + 1]! - pic.sat[d + 1]! - pic.sat[c + 1]! + pic.sat[e + 1]!) / area - dark[1]; // prettier-ignore
			b = (pic.sat[a + 2]! - pic.sat[d + 2]! - pic.sat[c + 2]! + pic.sat[e + 2]!) / area - dark[2]; // prettier-ignore
		}
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
