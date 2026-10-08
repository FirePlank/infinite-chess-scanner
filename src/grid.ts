/**
 * Locates the square grid from the edges between the two tile colors, to a negligible fraction
 * of a pixel, and samples every fully visible square.
 */

import type { Picture } from './picture.js';
import type { Tiles } from './tiles.js';

import { colorDistance } from './color.js';
import { samplePatch } from './picture.js';
import { projectOntoTiles } from './tiles.js';

// Types -----------------------------------------------------------------------

/** The squares along one image axis: square n spans [origin + n*size, origin + (n+1)*size). */
interface Axis {
	origin: number;
	count: number;
}

/** The board's square grid within the image. */
export interface Grid {
	size: number;
	x: Axis;
	y: Axis;
}

/** One square's bounds in the image, in pixels. */
export interface Square {
	left: number;
	top: number;
	size: number;
}

// Constants -------------------------------------------------------------------

/** Smallest square size readable, in pixels. */
const MIN_SQUARE_SIZE = 6.5;

/** How far a square may poke out of the image and still count as fully visible, in pixels. */
const EDGE_TOLERANCE = 0.75;

// Grid ------------------------------------------------------------------------

/**
 * Locates the square grid from the edges between the two tile colors.
 * @throws If there's no checkerboard, or its squares are too small to read.
 */
export function findGrid(pic: Picture, tiles: Tiles): Grid {
	const [xEdges, yEdges] = edgeProfiles(pic, tileShades(pic, tiles));
	const maxSize = Math.min(pic.width, pic.height) / 2;
	const size = refineSquareSize(xEdges, yEdges, coarseSquareSize(xEdges, yEdges, maxSize));
	if (size < MIN_SQUARE_SIZE) throw new Error(`The squares are under ${MIN_SQUARE_SIZE}px, too small to read. Zoom in.`); // prettier-ignore
	return { size, x: placeAxis(xEdges, size, pic.width), y: placeAxis(yEdges, size, pic.height) };
}

/** Each pixel's position from the dark (0) to the light (1) tile color, or NaN if it's neither. */
function tileShades(pic: Picture, tiles: Tiles): Float32Array {
	const tolerance = 0.25 * colorDistance(tiles[0], tiles[1]) + 0.02;
	const shades = new Float32Array(pic.width * pic.height);
	for (let i = 0; i < shades.length; i++) {
		const [t, off] = projectOntoTiles(pic, i, tiles);
		shades[i] = off < tolerance && t > -0.25 && t < 1.25 ? t : NaN;
	}
	return shades;
}

/** Total shade change across each vertical, and each horizontal, pixel boundary. */
function edgeProfiles(pic: Picture, shades: Float32Array): [Float64Array, Float64Array] {
	const { width, height } = pic;
	// Index n is the boundary at coordinate n, between pixels n-1 and n.
	const xEdges = new Float64Array(width + 1);
	const yEdges = new Float64Array(height + 1);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const here = shades[y * width + x]!;
			if (x + 1 < width) xEdges[x + 1]! += Math.abs(shades[y * width + x + 1]! - here) || 0;
			if (y + 1 < height)
				yEdges[y + 1]! += Math.abs(shades[(y + 1) * width + x]! - here) || 0;
		}
	}
	return [xEdges, yEdges];
}

/**
 * The square size to the nearest pixel: the first strong peak of the edges' autocorrelation.
 * @throws If there's none.
 */
function coarseSquareSize(xEdges: Float64Array, yEdges: Float64Array, maxSize: number): number {
	const maxLag = Math.floor(maxSize) + 1;
	const correlation = new Float64Array(maxLag + 2);
	for (const edges of [xEdges, yEdges]) {
		for (let lag = 1; lag <= maxLag + 1; lag++) {
			for (let n = 0; n + lag < edges.length; n++)
				correlation[lag]! += edges[n]! * edges[n + lag]!;
		}
	}
	// Summing neighbors catches a fractional size, whose edges alternate between two spacings.
	const smoothed = (lag: number): number =>
		correlation[lag - 1]! + correlation[lag]! + correlation[lag + 1]!;
	// Lags below 3 only measure the blur across single edges.
	const peaks: number[] = [];
	for (let lag = 3; lag <= maxLag; lag++) {
		if (smoothed(lag) >= smoothed(lag - 1) && smoothed(lag) >= smoothed(lag + 1))
			peaks.push(lag);
	}
	const highest = Math.max(...peaks.map((lag) => smoothed(lag)));
	const first = peaks.find((lag) => smoothed(lag) > 0.5 * highest);
	if (first === undefined) throw new Error('No checkerboard with readable squares found in the image.'); // prettier-ignore
	return first;
}

/** The exact square size near a coarse one, where the edges repeat most strongly. */
function refineSquareSize(xEdges: Float64Array, yEdges: Float64Array, coarse: number): number {
	const xSparse = sparseEdges(xEdges);
	const ySparse = sparseEdges(yEdges);
	const strength = (size: number): number =>
		Math.hypot(...combCoefficient(xSparse, size)) +
		Math.hypot(...combCoefficient(ySparse, size));
	let best = coarse;
	let bestStrength = strength(best);
	for (let size = coarse - 1.5; size <= coarse + 1.5; size += 0.002) {
		const candidate = strength(size);
		if (candidate <= bestStrength) continue;
		best = size;
		bestStrength = candidate;
	}
	// Golden-section search down to a negligible fraction of a pixel across the whole image.
	let lo = best - 0.002;
	let hi = best + 0.002;
	const ratio = (Math.sqrt(5) - 1) / 2;
	while (hi - lo > 1e-7) {
		const a = hi - ratio * (hi - lo);
		const b = lo + ratio * (hi - lo);
		if (strength(a) > strength(b)) hi = b;
		else lo = a;
	}
	return (lo + hi) / 2;
}

/** The nonzero entries of an edge profile, as [position, weight] pairs. */
function sparseEdges(edges: Float64Array): [number, number][] {
	const sparse: [number, number][] = [];
	for (let n = 0; n < edges.length; n++) if (edges[n]! > 0) sparse.push([n, edges[n]!]);
	return sparse;
}

/** The weight-normalized Fourier coefficient of sparse edges at a period, as [re, im]. */
function combCoefficient(edges: [number, number][], period: number): [number, number] {
	let re = 0;
	let im = 0;
	let total = 0;
	const step = (2 * Math.PI) / period;
	for (const [n, weight] of edges) {
		re += weight * Math.cos(step * n);
		im -= weight * Math.sin(step * n);
		total += weight;
	}
	return [re / total, im / total];
}

/** Places the fully visible squares along one axis, from the phase of its edges. */
function placeAxis(edges: Float64Array, size: number, length: number): Axis {
	const [re, im] = combCoefficient(sparseEdges(edges), size);
	const phase = (-Math.atan2(im, re) / (2 * Math.PI)) * size;
	const origin = phase + Math.ceil((-EDGE_TOLERANCE - phase) / size) * size;
	const count = Math.floor((length + EDGE_TOLERANCE - origin) / size);
	return { origin, count };
}

// Squares ---------------------------------------------------------------------

/** The bounds of the square in a column and row. */
export function squareAt(grid: Grid, column: number, row: number): Square {
	return {
		left: grid.x.origin + column * grid.size,
		top: grid.y.origin + row * grid.size,
		size: grid.size,
	};
}

/** Box-averages every fully visible square down to a samples x samples patch, indexed [row][column]. */
export function samplePatches(pic: Picture, grid: Grid, samples: number): Float32Array[][] {
	const patches: Float32Array[][] = [];
	for (let row = 0; row < grid.y.count; row++) {
		const line: Float32Array[] = [];
		for (let column = 0; column < grid.x.count; column++) {
			const { left, top, size } = squareAt(grid, column, row);
			line.push(samplePatch(pic, left, top, size, samples));
		}
		patches.push(line);
	}
	return patches;
}
