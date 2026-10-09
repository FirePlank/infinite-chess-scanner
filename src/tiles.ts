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
	// Exact pixel votes describe screenshots well, but repeated display stripes are a different
	// sampling process. Detect them before allocating and tallying a full-resolution histogram.
	// An averaged palette still needs repeated checkerboard evidence before camera processing wins.
	if (hasDisplayNoise(pic)) {
		const averaged = averagedTileColors(pic);
		if (averaged) return averaged;
	}
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

/** A camera's repeated display stripes vary where flat screenshot areas repeat exact pixels. */
function hasDisplayNoise(pic: Picture): boolean {
	let same = 0;
	let total = 0;
	for (let i = 0; i < pic.width * pic.height - 1; i += 11) {
		if (i % pic.width === pic.width - 1) continue;
		total++;
		if (pic.rgb[i * 3] === pic.rgb[(i + 1) * 3] && pic.rgb[i * 3 + 1] === pic.rgb[(i + 1) * 3 + 1] && pic.rgb[i * 3 + 2] === pic.rgb[(i + 1) * 3 + 2]) same++; // prettier-ignore
	}
	if (same >= 0.35 * total) return false;
	// Resampling and JPEG compression also destroy exact equality. Their edges grow farther apart
	// over the first few pixels; display stripes repeat, so their difference falls again. Check both
	// axes because the camera may be turned. A substantial fall avoids noise from finite sampling.
	const { width, height, rgb } = pic;
	for (const step of [1, width]) {
		let previous = 0;
		for (let offset = 1; offset <= 4; offset++) {
			let energy = 0;
			let samples = 0;
			for (let i = 0; i < width * height; i += 23) {
				if (step === 1 ? i % width + offset >= width : i + offset * width >= width * height) continue; // prettier-ignore
				const a = i * 3;
				const b = (i + offset * step) * 3;
				const r = rgb[a]! - rgb[b]!;
				const g = rgb[a + 1]! - rgb[b + 1]!;
				const blue = rgb[a + 2]! - rgb[b + 2]!;
				energy += r * r + g * g + blue * blue;
				samples++;
			}
			energy /= samples;
			if (previous > 0.0001 && energy < 0.9 * previous) return true;
			previous = energy;
		}
	}
	return false;
}

/** Checkerboard color votes from small averaged patches, at both axis and diagonal corners. */
function averagedTileColors(pic: Picture): Tiles | undefined {
	const narrow = averagedPalette(pic, 2, [4, 7]);
	const wide = averagedPalette(pic, 4, [12, 18]);
	// Wider patches remove stripes that still dominate small patches, and clear text strokes.
	// Count support relative to the area around a corner covered by each stencil. Keep a proven
	// narrow palette when the wider stencil agrees, so glare does not unnecessarily shift it.
	let best = narrow;
	if (wide && (!narrow || (wide.score > narrow.score && differentPalette(narrow.tiles, wide.tiles)))) best = wide; // prettier-ignore
	return best?.tiles;
}

/** Glare moves a palette along its existing contrast direction; a different theme changes it. */
function differentPalette(narrow: Tiles, wide: Tiles): boolean {
	const a: RGB = [narrow[1][0] - narrow[0][0], narrow[1][1] - narrow[0][1], narrow[1][2] - narrow[0][2]]; // prettier-ignore
	const b: RGB = [wide[1][0] - wide[0][0], wide[1][1] - wide[0][1], wide[1][2] - wide[0][2]]; // prettier-ignore
	const lengthA = Math.hypot(...a);
	const lengthB = Math.hypot(...b);
	const agreement = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (lengthA * lengthB);
	return agreement < 0.95 || lengthB > 1.5 * lengthA;
}

/** A palette from one patch size, requiring repeated checkerboard evidence at both reaches. */
function averagedPalette(
	pic: Picture,
	radius: number,
	reaches: readonly [number, number],
): { tiles: Tiles; score: number } | undefined {
	const votes = new Map<
		number,
		{ count: number; sums: number[]; firstReach: number; secondReach: number }
	>();
	const { width, height, sat } = pic;
	const stride = (width + 1) * 3;
	const side = radius * 2 + 1;
	const area = side * side;
	const colors = new Float64Array(12);
	const mean = (x: number, y: number, offset: number): void => {
		const a = (y - radius) * stride + (x - radius) * 3;
		const b = a + side * 3;
		const c = a + side * stride;
		const d = c + side * 3;
		colors[offset] = (sat[d]! - sat[b]! - sat[c]! + sat[a]!) / area;
		colors[offset + 1] = (sat[d + 1]! - sat[b + 1]! - sat[c + 1]! + sat[a + 1]!) / area; // prettier-ignore
		colors[offset + 2] = (sat[d + 2]! - sat[b + 2]! - sat[c + 2]! + sat[a + 2]!) / area; // prettier-ignore
	};
	const bin = (color: RGB): number => color.reduce((n, value) => n * 16 + Math.min(15, Math.floor(value * 16)), 0); // prettier-ignore
	const distanceSq = (a: number, b: number): number => (colors[a]! - colors[b]!) ** 2 + (colors[a + 1]! - colors[b + 1]!) ** 2 + (colors[a + 2]! - colors[b + 2]!) ** 2; // prettier-ignore
	for (const reach of reaches) {
		for (const diagonal of [true, false]) {
			for (let y = reach + radius; y < height - reach - radius; y += 2) {
				for (let x = reach + radius; x < width - reach - radius; x += 2) {
					if (diagonal) {
						mean(x - reach, y - reach, 0);
						mean(x + reach, y - reach, 3);
						mean(x + reach, y + reach, 6);
						mean(x - reach, y + reach, 9);
					} else {
						mean(x - reach, y, 0);
						mean(x, y - reach, 3);
						mean(x + reach, y, 6);
						mean(x, y + reach, 9);
					}
					if (distanceSq(0, 6) > 0.06 ** 2 || distanceSq(3, 9) > 0.06 ** 2 || distanceSq(0, 3) < 0.15 ** 2) continue; // prettier-ignore
					let first: RGB = [(colors[0]! + colors[6]!) / 2, (colors[1]! + colors[7]!) / 2, (colors[2]! + colors[8]!) / 2]; // prettier-ignore
					let second: RGB = [(colors[3]! + colors[9]!) / 2, (colors[4]! + colors[10]!) / 2, (colors[5]! + colors[11]!) / 2]; // prettier-ignore
					if (luminance(first) > luminance(second)) [first, second] = [second, first];
					const key = bin(first) * 4096 + bin(second);
					const vote = votes.get(key) ?? { count: 0, sums: [0, 0, 0, 0, 0, 0], firstReach: 0, secondReach: 0 }; // prettier-ignore
					vote.count++;
					if (reach === reaches[0]) vote.firstReach++;
					else vote.secondReach++;
					for (let channel = 0; channel < 3; channel++) {
						vote.sums[channel]! += first[channel]!;
						vote.sums[channel + 3]! += second[channel]!;
					}
					votes.set(key, vote);
				}
			}
		}
	}
	// Small repeating obstacles can alternate at one reach. The same tile colors must meet at
	// both reaches repeatedly to distinguish broad checkerboard squares from those repeated marks.
	// Discard those marks before ranking: their stronger votes must not hide a real board pair.
	const best = [...votes.values()]
		.filter((vote) => vote.count >= 12 && vote.firstReach >= 3 && vote.secondReach >= 3)
		.sort((a, b) => b.count - a.count)[0];
	if (!best) return undefined;
	const tiles: Tiles = [best.sums.slice(0, 3).map((value) => value / best.count) as RGB, best.sums.slice(3).map((value) => value / best.count) as RGB]; // prettier-ignore
	tiles.photographed = true;
	return { tiles, score: best.count / ((reaches[0] - radius) ** 2 + (reaches[1] - radius) ** 2) };
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
			const x0 = Math.max(0, x - 3);
			const y0 = Math.max(0, y - 3);
			const x1 = Math.min(pic.width, x + 4);
			const y1 = Math.min(pic.height, y + 4);
			const stride = pic.width + 1;
			const area = (x1 - x0) * (y1 - y0);
			const a = (y1 * stride + x1) * 3;
			const d = (y0 * stride + x1) * 3;
			const c = (y1 * stride + x0) * 3;
			const e = (y0 * stride + x0) * 3;
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
