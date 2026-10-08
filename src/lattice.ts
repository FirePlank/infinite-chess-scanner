/**
 * Finds the board's homography from its checkerboard corners, for screenshots at any angle. The
 * corners are grown into a lattice outward from the middle of the screenshot, each one predicted
 * by the homography fitted so far, and the final fit uses every corner that agrees with it.
 */

import type { Picture } from './picture.js';
import type { Homography, Point } from './homography.js';

import { compose, fitHomography, project } from './homography.js';

// Types -----------------------------------------------------------------------

/** Board-grid coordinates, as `column,row`. */
type LatticeKey = `${number},${number}`;

// Constants -------------------------------------------------------------------

/** The radius of the ring of pixels a corner is recognized by. */
const RING_RADIUS = 3;

/** How many pixels make up that ring. */
const RING_POINTS = 16;

/** How many of the ring's opposite pixel pairs may disagree, as ones on a tile edge go either way. */
const RING_MISMATCHES = 2;

/** How far from its predicted spot a corner may be, as a fraction of the squares there. */
const SNAP_RADIUS = 0.3;

/** How far from the fitted homography a lattice corner may be and still count toward it, in pixels. */
const OUTLIER_DISTANCE = 1.5;

/** How many corners near the middle of the image are tried as the lattice's seed. */
const SEED_ATTEMPTS = 12;

/** How far from a seed its first neighbors are looked for, in pixels. */
const SEED_NEIGHBORHOOD = 120;

/** The side of the cells corners are bucketed into, in pixels. */
const CELL_SIZE = 16;

/** How far down the screen an axis must point to be one the pieces might stand along, as a cosine. */
const MIN_DOWNWARDNESS = 0.05;

/** How much the lattice grows before its homography is refitted to predict further corners. */
const REFIT_GROWTH = 1.1;

/** How many lattice corners settle the homography without trying further seeds. */
const ENOUGH_LATTICE_CORNERS = 200;

/** How few lattice corners leave the homography too uncertain to trust. */
const MIN_LATTICE_CORNERS = 12;

// State -----------------------------------------------------------------------

/** The rings of {@link ringOffsets}, by image width. */
const RINGS = new Map<number, Int32Array>();

/** Scratch ring values for {@link isCornerNear}, reused across its calls. */
const RING_VALUES = new Int8Array(RING_POINTS);

// Corners ---------------------------------------------------------------------

/**
 * The checkerboard's corners: where a ring of pixels around a point runs dark, light, dark, light,
 * each point matching the one opposite it. Unlike reading along the image axes, this works at any
 * rotation and slant.
 */
export function findCorners(pic: Picture, classes: Int8Array): Point[] {
	const { width, height } = pic;
	const ring = ringOffsets(width);
	const hits = new Uint8Array(width * height);
	const values = new Int8Array(RING_POINTS);
	for (let y = RING_RADIUS; y < height - RING_RADIUS; y++) {
		for (let x = RING_RADIUS; x < width - RING_RADIUS; x++) {
			if (isCornerAt(classes, y * width + x, ring, values)) hits[y * width + x] = 1;
		}
	}
	return clusterCenters(hits, width);
}

/** Whether a checkerboard corner shows within a pixel of a point. */
export function isCornerNear(pic: Picture, classes: Int8Array, x: number, y: number): boolean {
	const ring = ringOffsets(pic.width);
	const values = RING_VALUES;
	for (let py = Math.floor(y - 1.5); py <= Math.floor(y + 0.5); py++) {
		for (let px = Math.floor(x - 1.5); px <= Math.floor(x + 0.5); px++) {
			const inside = px >= RING_RADIUS && py >= RING_RADIUS && px < pic.width - RING_RADIUS && py < pic.height - RING_RADIUS; // prettier-ignore
			if (inside && isCornerAt(classes, py * pic.width + px, ring, values)) return true;
		}
	}
	return false;
}

/** Each pixel's tile: 0 for the dark, 1 for the light, -1 when it's neither. */
export function tileClasses(shades: Float32Array): Int8Array {
	const classes = new Int8Array(shades.length);
	for (let i = 0; i < shades.length; i++) {
		const shade = shades[i]!;
		classes[i] = Number.isNaN(shade) ? -1 : shade < 0.5 ? 0 : 1;
	}
	return classes;
}

/** The offsets of the ring's pixels around a pixel, as index steps in an image of a width. Kept per width. */
function ringOffsets(width: number): Int32Array {
	const kept = RINGS.get(width);
	if (kept) return kept;
	const ring = new Int32Array(RING_POINTS);
	RINGS.set(width, ring);
	for (let k = 0; k < RING_POINTS; k++) {
		const angle = (2 * Math.PI * k) / RING_POINTS;
		ring[k] = Math.round(RING_RADIUS * Math.sin(angle)) * width + Math.round(RING_RADIUS * Math.cos(angle)); // prettier-ignore
	}
	return ring;
}

/** Whether the ring around a pixel shows a checkerboard corner. */
function isCornerAt(classes: Int8Array, at: number, ring: Int32Array, values: Int8Array): boolean {
	// Most pixels lie inside a tile, where every other point of the ring already agrees.
	const first = classes[at + ring[0]!]!;
	let uniform = true;
	for (let k = 0; k < RING_POINTS; k += 2) {
		const value = classes[at + ring[k]!]!;
		if (value < 0) return false;
		if (value !== first) uniform = false;
	}
	if (uniform) return false;
	for (let k = 0; k < RING_POINTS; k++) {
		const value = classes[at + ring[k]!]!;
		if (value < 0) return false;
		values[k] = value;
	}
	let changes = 0;
	let mismatches = 0;
	for (let k = 0; k < RING_POINTS; k++) {
		if (values[k] !== values[(k + 1) % RING_POINTS]) changes++;
		if (k < RING_POINTS / 2 && values[k] !== values[k + RING_POINTS / 2]) mismatches++;
	}
	return changes === 4 && mismatches <= RING_MISMATCHES;
}

/** The centers of each 8-connected cluster of hits, at pixel centers. */
function clusterCenters(hits: Uint8Array, width: number): Point[] {
	const centers: Point[] = [];
	const seen = new Uint8Array(hits.length);
	for (let start = 0; start < hits.length; start++) {
		if (!hits[start] || seen[start]) continue;
		const stack = [start];
		seen[start] = 1;
		let sumX = 0;
		let sumY = 0;
		let n = 0;
		while (stack.length > 0) {
			const i = stack.pop()!;
			const x = i % width;
			sumX += x;
			sumY += (i - x) / width;
			n++;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const j = i + dy * width + dx;
					if (j < 0 || j >= hits.length || !hits[j] || seen[j]) continue;
					seen[j] = 1;
					stack.push(j);
				}
			}
		}
		centers.push([sumX / n + 0.5, sumY / n + 0.5]);
	}
	return centers;
}

// Lattice ---------------------------------------------------------------------

/**
 * The homographies from board-grid coordinates to the image, with columns running right and rows
 * running down the screen as the pieces stand: one for each way they might, best aligned first.
 * Square (column, row) spans [column, column+1] x [row, row+1]. Undefined when the corners don't
 * form enough of a lattice.
 */
export function fitLattice(
	corners: Point[],
	width: number,
	height: number,
): Homography[] | undefined {
	const lattice = growLattice(corners, width, height);
	if (lattice === undefined) return undefined;
	const h = fitRobustly(lattice);
	if (h === undefined) return undefined;
	return orientations(h).map((relabeling) => compose(h, relabeling));
}

/**
 * Grows the lattice out from corners near the middle of the image, keeping the largest. A seed
 * can fail, as a stray corner beside a piece doesn't sit on the grid.
 */
function growLattice(
	corners: Point[],
	width: number,
	height: number,
): Map<LatticeKey, Point> | undefined {
	const index = new CornerIndex(corners);
	const middle: Point = [width / 2, height / 2];
	// Seeds spread outward from the middle, as stray corners cluster where pieces stand.
	const byDistance = [...corners].sort((a, b) => distance(a, middle) - distance(b, middle));
	const stride = Math.max(1, Math.floor(corners.length / (4 * SEED_ATTEMPTS)));
	const seeds = byDistance.filter((_, i) => i % stride === 0).slice(0, SEED_ATTEMPTS);
	let best: Map<LatticeKey, Point> | undefined;
	for (const seed of seeds) {
		const lattice = growFrom(seed, index, width, height);
		if (lattice && lattice.size > (best?.size ?? 0)) best = lattice;
		if (best && (best.size >= ENOUGH_LATTICE_CORNERS || best.size > corners.length / 2)) break;
	}
	return best && best.size >= MIN_LATTICE_CORNERS ? best : undefined;
}

/** Grows the lattice out from one corner, ring by ring, predicting each corner by the homography fitted so far. */
function growFrom(
	seed: Point,
	index: CornerIndex,
	width: number,
	height: number,
): Map<LatticeKey, Point> | undefined {
	const lattice = seedLattice(seed, index);
	if (lattice === undefined) return undefined;
	const used = new Set(lattice.values());
	let h = fitHomography(pairsOf(lattice));
	let fitted = lattice.size;
	// Rings that add nothing are tolerated a few times, as a row of pieces can hide a ring's corners.
	for (let radius = 2, emptyRings = 0; emptyRings < 3; radius++) {
		let added = 0;
		for (let column = -radius; column <= radius; column++) {
			for (let row = -radius; row <= radius; row++) {
				if (Math.max(Math.abs(column), Math.abs(row)) !== radius) continue;
				const corner = snap(h, column, row, index, used, width, height);
				if (corner === undefined) continue;
				lattice.set(`${column},${row}`, corner);
				used.add(corner);
				added++;
			}
		}
		emptyRings = added === 0 ? emptyRings + 1 : 0;
		// Refitting once the lattice has grown a little predicts the next ring just as well.
		if (lattice.size >= REFIT_GROWTH * fitted) {
			h = fitHomography(pairsOf(lattice));
			fitted = lattice.size;
		}
	}
	return lattice;
}

/**
 * The first lattice corners: a seed, its nearest neighbor along one grid line, its nearest
 * neighbor along the other, and the corners opposite those two.
 */
function seedLattice(seed: Point, index: CornerIndex): Map<LatticeKey, Point> | undefined {
	const others = index.near(seed, SEED_NEIGHBORHOOD).filter((corner) => corner !== seed);
	others.sort((a, b) => distance(a, seed) - distance(b, seed));
	const first = others[0];
	const second = others.find((c) => first && angleBetween(c, first, seed) > Math.PI / 5);
	if (first === undefined || second === undefined) return undefined;
	const lattice = new Map<LatticeKey, Point>([
		['0,0', seed],
		['1,0', first],
		['0,1', second],
	]);
	for (const [key, neighbor] of [
		['-1,0', first],
		['0,-1', second],
	] as const) {
		const mirrored: Point = [2 * seed[0] - neighbor[0], 2 * seed[1] - neighbor[1]];
		const opposite = index.nearest(mirrored, SNAP_RADIUS * distance(seed, neighbor));
		if (opposite) lattice.set(key, opposite);
	}
	return lattice.size >= 5 ? lattice : undefined;
}

/** The detected corner nearest where the homography puts a lattice point, if near enough. */
function snap(
	h: Homography,
	column: number,
	row: number,
	index: CornerIndex,
	used: Set<Point>,
	width: number,
	height: number,
): Point | undefined {
	const predicted = project(h, column, row);
	if (predicted[0] < 0 || predicted[1] < 0 || predicted[0] > width || predicted[1] > height) return undefined; // prettier-ignore
	const spacing = Math.min(distance(predicted, project(h, column + 1, row)), distance(predicted, project(h, column, row + 1))); // prettier-ignore
	if (!(spacing > 2 * RING_RADIUS)) return undefined;
	const corner = index.nearest(predicted, SNAP_RADIUS * spacing);
	return corner === undefined || used.has(corner) ? undefined : corner;
}

/** Fits the lattice's homography, refitting without the corners that disagree with it. */
function fitRobustly(lattice: Map<LatticeKey, Point>): Homography | undefined {
	let pairs = pairsOf(lattice);
	let h = fitHomography(pairs);
	for (let round = 0; round < 3; round++) {
		pairs = pairs.filter(
			([at, corner]) => distance(project(h, ...at), corner) < OUTLIER_DISTANCE,
		);
		if (pairs.length < MIN_LATTICE_CORNERS) return undefined;
		h = fitHomography(pairs);
	}
	return h;
}

/**
 * The lattice relabelings that might put the rows down the screen as the pieces stand. The site
 * flips pieces once the view turns past 90°, so they face along whichever board axis points up the
 * screen at all: one or two of them.
 */
function orientations(h: Homography): Homography[] {
	const origin = project(h, 0, 0);
	const towards = (axis: Point): Point => {
		const p = project(h, axis[0] * 0.01, axis[1] * 0.01);
		const length = distance(p, origin);
		return [(p[0] - origin[0]) / length, (p[1] - origin[1]) / length];
	};
	const axes: Point[] = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // prettier-ignore
	const downs = axes
		.filter((axis) => towards(axis)[1] > MIN_DOWNWARDNESS)
		.sort((a, b) => towards(b)[1] - towards(a)[1]);
	return downs.map((down) => {
		// Right is the perpendicular axis that turns clockwise into down on screen.
		const right = axes.find((axis) => {
			if (axis[0] * down[0] + axis[1] * down[1] !== 0) return false;
			const [r, d] = [towards(axis), towards(down)];
			return r[0] * d[1] - r[1] * d[0] > 0;
		})!;
		return [right[0], down[0], 0, right[1], down[1], 0, 0, 0, 1];
	});
}

// Helpers ---------------------------------------------------------------------

/** The lattice as (lattice point, image point) pairs. */
function pairsOf(lattice: Map<LatticeKey, Point>): [Point, Point][] {
	return [...lattice].map(([key, corner]) => [key.split(',').map(Number) as Point, corner]);
}

/** Corners bucketed into square cells, for finding those near a point without visiting all. */
class CornerIndex {
	private readonly cells = new Map<number, Point[]>();

	constructor(corners: Point[]) {
		for (const corner of corners) {
			const key = this.cellOf(corner[0], corner[1]);
			const cell = this.cells.get(key);
			if (cell) cell.push(corner);
			else this.cells.set(key, [corner]);
		}
	}

	/** Every corner within a distance of a point. */
	near(point: Point, within: number): Point[] {
		const found: Point[] = [];
		const reach = Math.ceil(within / CELL_SIZE);
		const [cx, cy] = [Math.floor(point[0] / CELL_SIZE), Math.floor(point[1] / CELL_SIZE)];
		for (let dy = -reach; dy <= reach; dy++) {
			for (let dx = -reach; dx <= reach; dx++) {
				for (const corner of this.cells.get(cellKey(cx + dx, cy + dy)) ?? []) {
					if (distance(corner, point) <= within) found.push(corner);
				}
			}
		}
		return found;
	}

	/** The corner nearest a point, if any is within a distance. */
	nearest(point: Point, within: number): Point | undefined {
		let best: Point | undefined;
		for (const corner of this.near(point, within)) {
			if (best === undefined || distance(corner, point) < distance(best, point))
				best = corner;
		}
		return best;
	}

	/** The key of the cell holding a point. */
	private cellOf(x: number, y: number): number {
		return cellKey(Math.floor(x / CELL_SIZE), Math.floor(y / CELL_SIZE));
	}
}

/** The key of the cell at a column and row of cells. */
function cellKey(column: number, row: number): number {
	return row * 65536 + column;
}

/** The distance between two points. */
function distance(a: Point, b: Point): number {
	return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
}

/** The angle between the lines from a center through two points, ignoring direction, in [0, π/2]. */
function angleBetween(a: Point, b: Point, center: Point): number {
	const angle = Math.abs(Math.atan2(a[1] - center[1], a[0] - center[0]) - Math.atan2(b[1] - center[1], b[0] - center[0])) % Math.PI; // prettier-ignore
	return Math.min(angle, Math.PI - angle);
}
