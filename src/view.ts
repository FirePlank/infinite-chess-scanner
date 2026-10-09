/**
 * Where the board sits in a screenshot: the homography placing its grid, and the squares shown
 * well enough to read. A screenshot looking straight down gets its grid from the period of the
 * tile edges, exact to a negligible fraction of a pixel; one at an angle, from its corners.
 */

import type { Grid } from './grid.js';
import type { Picture } from './picture.js';
import type { Tiles } from './tiles.js';
import type { Homography, Point } from './homography.js';
import type { RGB } from './color.js';

import { EDGE_TOLERANCE, findGrid } from './grid.js';
import { colorDistance } from './color.js';
import { colorAt } from './picture.js';
import { isTileColor, tileShades } from './tiles.js';
import {
	findCorners,
	findPhotographedCorners,
	fitLattice,
	isCornerNear,
	tileClasses,
} from './lattice.js';
import {
	compose,
	fitHomography,
	invert,
	isInFront,
	project,
	raise,
	stretch,
} from './homography.js';

// Types -----------------------------------------------------------------------

/** One square of the board. */
export interface Square {
	column: number;
	row: number;
	/**
	 * Its size on screen, in pixels, as the site picks a mipmap level by: across its narrower
	 * extent, which on a board seen at an angle is the one along the line of sight.
	 */
	size: number;
}

/** How a plane on the board's grid sits in a screenshot. */
export interface Plane {
	/** Maps board-grid coordinates to image pixels: square (column, row) spans [column, column+1] x [row, row+1]. */
	toImage: Homography;
	toBoard: Homography;
}

/** How the board's grid sits in a screenshot. */
export interface View extends Plane {
	/** The plane the pieces are drawn on, just above the board's. */
	pieces: Plane;
	/** Every square fully on screen and large enough to read. */
	squares: Square[];
	/** Whether the board is seen at an angle. */
	perspective: boolean;
	/** Whether broad application bars surround the board viewport. */
	embedded?: true;
	/** Checkerboard intersections supported by local image evidence, as `column,row`. */
	cornerSupport?: ReadonlySet<string>;
	/** Intersections observed directly, before inferring small gaps in the visible grid. */
	measuredCornerSupport?: ReadonlySet<string>;
}

// Constants -------------------------------------------------------------------

/** Smallest square size readable, in pixels. */
const MIN_SQUARE_SIZE = 6.5;

/** The fraction of the checkerboard corners a straight-down grid must sit on to be believed. */
const GRID_CORNER_AGREEMENT = 0.6;

/** How few corners make that check meaningless, as on a board crowded by obstacles. */
const MIN_CORNERS_TO_CHECK = 20;

/** The fraction of a lattice's bare square centers that must alternate between the tile colors. */
const CHECKERED_AGREEMENT = 0.9;

/**
 * How far above the board the site draws its pieces at an angle, as a fraction of its camera's
 * height: pieces at 0.005, tiles at -0.01, the camera at 12.
 */
const PIECE_RISE = 0.015 / 12.01;

/** The most squares read at an angle, which keeps a view toward the horizon bounded. */
const MAX_SQUARES = 20000;

// Functions -------------------------------------------------------------------

/**
 * How the board's grid might sit in a screenshot. Seen at an angle, it can take two, one for each
 * way the pieces might stand, for the pieces themselves to tell apart.
 * @throws If there's no checkerboard, or its squares are too small to read.
 */
export function findViews(pic: Picture, tiles: Tiles, embedded = false): View[] {
	const shades = tileShades(pic, tiles);
	const classes = tileClasses(shades);
	let grid: Grid | undefined;
	let gridError: unknown;
	if (!tiles.photographed) {
		try {
			grid = findGrid(pic, shades);
		} catch (error) {
			gridError = error;
		}
	}
	if (grid && !tiles.photographed && areGridCornersShown(pic, classes, grid))
		return [flatView(grid)];
	let corners = findCorners(pic, classes, tiles.photographed ? shades : undefined);
	if (grid && !tiles.photographed && isGridOnCorners(grid, corners)) return [flatView(grid)];
	let homographies = fitLattice(corners, pic.width, pic.height, tiles.photographed, tiles.photographed ? (h, centers) => isCheckerLattice(pic, h, centers, shades) : undefined); // prettier-ignore
	if (tiles.photographed && (!homographies || corners.length < 150)) {
		const localCorners = findPhotographedCorners(pic);
		const local = fitLattice(
			localCorners,
			pic.width,
			pic.height,
			true,
			(h, centers) => isCheckerLattice(pic, h, centers),
			true,
		);
		if (
			local &&
			(!homographies ||
				(samePhotoGrid(homographies[0]!, local[0]!) &&
					cornerAgreement(local[0]!, localCorners) >
						1.25 * cornerAgreement(homographies[0]!, localCorners)))
		) {
			homographies = local;
			corners = localCorners;
		}
	}
	if (homographies) {
		if (tiles.photographed) {
			const initial = homographies[0]!;
			const refined = refinePhotograph(pic, perspectiveView(pic, initial, true));
			if (refined) {
				const correction = compose(refined, invert(initial));
				homographies = homographies.map((h) => compose(correction, h));
			}
		}
		const center = embedded && !tiles.photographed ? viewportCenter(pic, shades) : undefined;
		const views = homographies.map((toImage) => perspectiveView(pic, toImage, tiles.photographed, center, corners)); // prettier-ignore
		// Closely spaced round obstacles can supply a checkerboard of edge midpoints, rotated
		// halfway between the real axes. Keep the real-cell alternatives for piece shapes to judge.
		if (tiles.photographed && hasAlternatingMarks(pic, views[0]!)) {
			for (const h of homographies) {
				for (const phase of [-0.5, 0.5]) {
					const toImage = compose(h, [1, -1, 0.5, 1, 1, phase, 0, 0, 1]);
					const alternative = perspectiveView(pic, toImage, true, undefined, corners);
					if ((alternative.cornerSupport?.size ?? 0) >= 16) views.push(alternative);
				}
			}
		}
		if (tiles.photographed || isCheckered(pic, tiles, views[0]!)) return views;
	}
	if (grid && !tiles.photographed) return [flatView(grid)];
	throw gridError ?? new Error('No checkerboard with readable squares found in the image.');
}

/** A genuine dark tile stays dark at its rim; a mark mistaken for that tile has a bright rim. */
function hasAlternatingMarks(pic: Picture, view: View): boolean {
	const counts = [0, 0];
	const marks = [0, 0];
	const plain = [0, 0];
	for (const { column, row } of view.squares) {
		if (
			![`${column},${row}`, `${column + 1},${row}`, `${column},${row + 1}`, `${column + 1},${row + 1}`].every((key) => view.cornerSupport?.has(key)) // prettier-ignore
		)
			continue;
		const center = colorNear(pic, view.toImage, column + 0.5, row + 0.5, 2);
		const rim = [[0.15, 0.15], [0.85, 0.15], [0.85, 0.85], [0.15, 0.85]].map(([x, y]) => colorNear(pic, view.toImage, column + x!, row + y!, 2)); // prettier-ignore
		if (!center || rim.some((color) => !color)) continue;
		const colors = rim as [number, number, number][];
		const background = [0, 1, 2].map((channel) => colors.reduce((sum, color) => sum + color[channel]!, 0) / 4) as [number, number, number]; // prettier-ignore
		if (colors.some((color) => colorDistance(color, background) > 0.08)) continue;
		const parity = (((column + row) % 2) + 2) % 2;
		counts[parity]!++;
		const contrast = colorDistance(center, background);
		if (contrast < 0.08) plain[parity]!++;
		else if (contrast > 0.15 && center.reduce((sum, value) => sum + value, 0) < background.reduce((sum, value) => sum + value, 0) - 0.15) marks[parity]!++; // prettier-ignore
	}
	return [0, 1].some((parity) => counts[parity]! >= 20 && counts[1 - parity]! >= 20 && marks[parity]! > counts[parity]! * 0.6 && plain[1 - parity]! > counts[1 - parity]! * 0.6); // prettier-ignore
}

/**
 * A global palette can hide corners in photographic shadow or glare. Measure local crossings
 * around the preliminary grid and fit again, so visible corners throughout the board calibrate
 * the mapping instead of extrapolating from one bright area.
 */
function refinePhotograph(pic: Picture, view: View): Homography | undefined {
	const coordinates = new Set(view.squares.flatMap(({ column, row }) => [
		`${column},${row}`, `${column + 1},${row}`, `${column},${row + 1}`, `${column + 1},${row + 1}`,
	])); // prettier-ignore
	const measured = new Map<string, [Point, Point]>();
	// Choose the stencil at the lattice seed, where its checkerboard was established. A large
	// board can extrapolate to tiny cells outside its viewport, where display marks are noise.
	const size = 1 / stretch(view.toBoard, ...project(view.toImage, 0, 0));
	const small = size < 30;
	const radius = small ? 1 : 2;
	const reaches = small ? [0.16, 0.28] : [0.065, 0.13];
	const colors: RGB[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]; // prettier-ignore
	for (const key of coordinates) {
		const [column, row] = key.split(',').map(Number) as Point;
		// At small zoom levels a five-pixel average straddles the crossing at the usual reach.
		// Sample farther into each quadrant, using a smaller patch to leave its edges behind.
		let best: Point | undefined;
		let bestQuality = -Infinity;
		for (let dy = -8; dy <= 8; dy++) {
			for (let dx = -8; dx <= 8; dx++) {
				const u = column + dx * 0.025;
				const v = row + dy * 0.025;
				let quality = -0.005 * Math.hypot(dx, dy);
				let checkered = true;
				for (const reach of reaches) {
					const a = colorNear(pic, view.toImage, u - reach, v - reach, radius, colors[0]);
					const b = colorNear(pic, view.toImage, u + reach, v - reach, radius, colors[1]);
					const c = colorNear(pic, view.toImage, u + reach, v + reach, radius, colors[2]);
					const d = colorNear(pic, view.toImage, u - reach, v + reach, radius, colors[3]);
					if (!a || !b || !c || !d) {
						checkered = false;
						break;
					}
					const firstContrast = colorDistance(a, b);
					if (firstContrast < 0.1) {
						checkered = false;
						break;
					}
					const contrast = Math.min(firstContrast, colorDistance(c, d));
					const variation = Math.max(colorDistance(a, c), colorDistance(b, d));
					if (variation > 0.1 || contrast < Math.max(0.1, 2 * variation)) {
						checkered = false;
						break;
					}
					quality += contrast - 2 * variation;
				}
				if (checkered && quality > bestQuality) {
					bestQuality = quality;
					best = project(view.toImage, u, v);
				}
			}
		}
		if (best) measured.set(key, [[column, row], small ? refineSmallCrossing(pic, best) : best]);
	}
	// Isolated marks can resemble a crossing. A measured grid crossing has measured neighbors.
	const pairs = [...measured.values()].filter(([[column, row]]) => [
		`${column - 1},${row}`, `${column + 1},${row}`, `${column},${row - 1}`, `${column},${row + 1}`,
	].filter((key) => measured.has(key)).length >= 2); // prettier-ignore
	if (pairs.length < 12) return undefined;
	const toImage = fitHomography(pairs);
	return toImage.every(Number.isFinite) ? toImage : undefined;
}

/** The saddle of an averaged crossing locates its edges within the broad quadrant-score peak. */
function refineSmallCrossing(pic: Picture, point: Point): Point {
	const [cx, cy] = point.map(Math.floor) as Point;
	let bx = 0;
	let by = 0;
	let xx = 0;
	let xy = 0;
	let yy = 0;
	const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	for (let y = -4; y <= 4; y++) {
		for (let x = -4; x <= 4; x++) {
			const color = colorNear(pic, identity, cx + x, cy + y, 2);
			if (!color) return point;
			const value = color[0] + color[1] + color[2];
			bx += value * x;
			by += value * y;
			xx += value * (x * x - 20 / 3);
			xy += value * x * y;
			yy += value * (y * y - 20 / 3);
		}
	}
	[bx, by, xx, xy, yy] = [bx / 540, by / 540, xx / 2772, xy / 3600, yy / 2772];
	const determinant = 4 * xx * yy - xy * xy;
	if (!(determinant < -1e-8)) return point;
	const x = (xy * by - 2 * yy * bx) / determinant;
	const y = (xy * bx - 2 * xx * by) / determinant;
	return Math.hypot(x, y) < 3 ? [cx + 0.5 + x, cy + 0.5 + y] : point;
}

/** The center of a board viewport embedded between broad application bars. */
function viewportCenter(pic: Picture, shades: Float32Array): Point | undefined {
	const rows: number[] = [];
	for (let y = 0; y < pic.height; y++) {
		let dark = 0;
		let light = 0;
		for (let x = 0; x < pic.width; x++) {
			const shade = shades[y * pic.width + x]!;
			if (shade < 0.2) dark++;
			else if (shade > 0.8) light++;
		}
		if (Math.min(dark, light) > pic.width * 0.1) rows.push(y);
	}
	const first = rows[0];
	const last = rows.at(-1);
	if (first === undefined || last === undefined || first < 20 || last > pic.height - 20) return undefined; // prettier-ignore
	return [pic.width / 2, (first + last + 1) / 2];
}

/**
 * A lattice must explain alternating tiles throughout its projected image domain. Restricting
 * the check to its seed's crossings can accept a small periodic moire patch as the whole board.
 * Local color differences keep this test independent of camera exposure and the global palette.
 */
function isCheckerLattice(
	pic: Picture,
	h: Homography,
	centers: Point[],
	shades?: Float32Array,
): boolean {
	let even = 0;
	let odd = 0;
	const nearby = new Set(centers.map(([column, row]) => `${column},${row}`));
	for (const [column, row] of centers) {
		const expected = (((Math.floor(column) + Math.floor(row)) % 2) + 2) % 2 === 0;
		if (shades) {
			const [x, y] = project(h, column, row);
			const shade = shades[Math.floor(y) * pic.width + Math.floor(x)]!;
			if (!Number.isFinite(shade) || (shade > 0.35 && shade < 0.65)) continue;
			if (shade < 0.5 === expected) even++;
			else odd++;
			continue;
		}
		const color = colorNear(pic, h, column, row, 2);
		if (!color) continue;
		const others = [
			[column + 1, row],
			[column - 1, row],
			[column, row + 1],
			[column, row - 1],
		]
			.filter(([c, r]) => nearby.has(`${c},${r}`))
			.map(([c, r]) => colorNear(pic, h, c!, r!, 2))
			.filter((neighbor) => neighbor && colorDistance(color, neighbor) > 0.1);
		if (others.length < 2) continue;
		const brightness = color.reduce((sum, value) => sum + value, 0);
		const darker = others.every(
			(neighbor) => brightness < neighbor!.reduce((sum, value) => sum + value, 0) - 0.1,
		);
		const lighter = others.every(
			(neighbor) => brightness > neighbor!.reduce((sum, value) => sum + value, 0) + 0.1,
		);
		if (!darker && !lighter) continue;
		if (darker === expected) even++;
		else odd++;
	}
	if (even + odd < Math.max(6, centers.length * 0.25) || Math.max(even, odd) < CHECKERED_AGREEMENT * (even + odd)) return false; // prettier-ignore
	return !!shades || !contradictsCheckerDomain(pic, h);
}

/** Many reliable contrary votes reject a local periodic patch; sparse occlusion evidence cannot. */
function contradictsCheckerDomain(pic: Picture, h: Homography): boolean {
	let squares: Square[];
	try {
		squares = perspectiveView(pic, h, true).squares;
	} catch {
		return true;
	}
	const nearby = new Set(squares.map(({ column, row }) => `${column},${row}`));
	let even = 0;
	let odd = 0;
	const stride = Math.max(1, Math.ceil(squares.length / 600));
	for (let index = 0; index < squares.length; index += stride) {
		const { column, row } = squares[index]!;
		const color = colorNear(pic, h, column + 0.5, row + 0.5, 2);
		if (!color) continue;
		const neighbors = [
			[-1, 0],
			[1, 0],
			[0, -1],
			[0, 1],
		]
			.filter(([dx, dy]) => nearby.has(`${column + dx!},${row + dy!}`))
			.map(([dx, dy]) => colorNear(pic, h, column + dx! + 0.5, row + dy! + 0.5, 2))
			.filter((neighbor): neighbor is [number, number, number] => !!neighbor);
		if (neighbors.length < 3) continue;
		const mean = [0, 1, 2].map((channel) => neighbors.reduce((sum, neighbor) => sum + neighbor[channel]!, 0) / neighbors.length) as [number, number, number]; // prettier-ignore
		const contrast = colorDistance(color, mean);
		const variation = Math.max(...neighbors.map((neighbor) => colorDistance(neighbor, mean)));
		if (contrast < 0.1 || variation > 0.45 * contrast) continue;
		const darker = color.reduce((sum, value) => sum + value, 0) < mean.reduce((sum, value) => sum + value, 0); // prettier-ignore
		if (darker === ((((column + row) % 2) + 2) % 2 === 0)) even++;
		else odd++;
	}
	const total = even + odd;
	const expectedErrors = (1 - CHECKERED_AGREEMENT) * total;
	const uncertainty = 3 * Math.sqrt(CHECKERED_AGREEMENT * expectedErrors);
	return Math.min(even, odd) > expectedErrors + uncertainty;
}

/** How many independent local crossings sit on a recovered grid. */
function cornerAgreement(h: Homography, corners: Point[]): number {
	const toBoard = invert(h);
	const supported = new Set<string>();
	for (const corner of corners) {
		const [column, row] = project(toBoard, ...corner);
		const [c, r] = [Math.round(column), Math.round(row)];
		if (Math.abs(column - c) < 0.15 && Math.abs(row - r) < 0.15) supported.add(`${c},${r}`);
	}
	return supported.size;
}

/** A better exposed part can refine a photographed grid without changing its square spacing. */
function samePhotoGrid(reference: Homography, candidate: Homography): boolean {
	const relabeling = compose(invert(candidate), reference);
	const origin = project(relabeling, 0, 0);
	return [
		[1, 0],
		[0, 1],
	].every(([column, row]) => {
		const point = project(relabeling, column!, row!);
		const dx = point[0] - origin[0];
		const dy = point[1] - origin[1];
		const length = Math.hypot(dx, dy);
		return length > 0.8 && length < 1.25 && Math.max(Math.abs(dx), Math.abs(dy)) > 0.9 * length;
	});
}

/**
 * Whether a view's squares alternate between the tile colors at their centers, as a real grid's
 * do. A lattice grown from noise, as squares too small for their corners leave, doesn't.
 */
function isCheckered(pic: Picture, [dark, light]: Tiles, view: View): boolean {
	let even = 0;
	let odd = 0;
	for (const { column, row } of view.squares) {
		const [x, y] = project(view.toImage, column + 0.5, row + 0.5);
		const color = colorAt(pic, Math.floor(y) * pic.width + Math.floor(x));
		if (!isTileColor(color, [dark, light])) continue;
		const isDark = colorDistance(color, dark) < colorDistance(color, light);
		if (isDark === ((((column + row) % 2) + 2) % 2 === 0)) even++;
		else odd++;
	}
	return Math.max(even, odd) >= CHECKERED_AGREEMENT * (even + odd);
}

/** The error for a board whose squares are all too small to read. */
function tooSmall(): Error {
	return new Error(`The squares are under ${MIN_SQUARE_SIZE}px, too small to read. Zoom in.`);
}

/**
 * Whether most of a straight-down grid's inner corners show as checkerboard corners, which settles
 * that the board is seen straight down without scanning the whole image for corners.
 */
function areGridCornersShown(pic: Picture, classes: Int8Array, grid: Grid): boolean {
	let shown = 0;
	let total = 0;
	for (let row = 1; row < grid.y.count; row++) {
		for (let column = 1; column < grid.x.count; column++) {
			const [x, y] = [grid.x.origin + column * grid.size, grid.y.origin + row * grid.size];
			if (isCornerNear(pic, classes, x, y)) shown++;
			total++;
		}
	}
	return total >= MIN_CORNERS_TO_CHECK && shown >= GRID_CORNER_AGREEMENT * total;
}

/** Whether a straight-down grid passes through the checkerboard's corners, as it does unless the board is seen at an angle. */
function isGridOnCorners(grid: Grid, corners: Point[]): boolean {
	if (corners.length < MIN_CORNERS_TO_CHECK) return true;
	const tolerance = Math.max(1, 0.1 * grid.size);
	const offGrid = (value: number, origin: number): number => {
		const steps = (value - origin) / grid.size;
		return Math.abs(steps - Math.round(steps)) * grid.size;
	};
	const onGrid = corners.filter(
		([x, y]) => offGrid(x, grid.x.origin) < tolerance && offGrid(y, grid.y.origin) < tolerance,
	);
	return onGrid.length >= GRID_CORNER_AGREEMENT * corners.length;
}

/**
 * The view of a board seen straight down.
 * @throws If its squares are too small to read.
 */
function flatView(grid: Grid): View {
	if (grid.size < MIN_SQUARE_SIZE) throw tooSmall();
	const toImage = [grid.size, 0, grid.x.origin, 0, grid.size, grid.y.origin, 0, 0, 1];
	const squares: Square[] = [];
	for (let row = 0; row < grid.y.count; row++) {
		for (let column = 0; column < grid.x.count; column++) squares.push({ column, row, size: grid.size }); // prettier-ignore
	}
	const toBoard = invert(toImage);
	return { toImage, toBoard, pieces: { toImage, toBoard }, squares, perspective: false };
}

/**
 * The view of a board seen at an angle: every readable square connected to the middle of its lattice.
 * @throws If none is large enough to read.
 */
function perspectiveView(
	pic: Picture,
	toImage: Homography,
	photographed = false,
	center?: Point,
	corners?: Point[],
): View {
	const toBoard = invert(toImage);
	const squares: Square[] = [];
	const seen = new Set<string>();
	const queue: Point[] = [[-1, -1], [0, -1], [-1, 0], [0, 0]]; // prettier-ignore
	for (const [column, row] of queue) seen.add(`${column},${row}`);
	for (let next = 0; next < queue.length && squares.length < MAX_SQUARES; next++) {
		const [column, row] = queue[next]!;
		const square = readableSquare(pic, toImage, toBoard, column, row);
		if (square === undefined) continue;
		squares.push(square);
		for (const [c, r] of [
			[column + 1, row],
			[column - 1, row],
			[column, row + 1],
			[column, row - 1],
		] as Point[]) {
			if (seen.has(`${c},${r}`)) continue;
			seen.add(`${c},${r}`);
			queue.push([c, r]);
		}
	}
	if (squares.length === 0) throw tooSmall();
	const piecesToImage = photographed ? toImage : raise(toImage, pic.width, pic.height, PIECE_RISE, center); // prettier-ignore
	const pieces = { toImage: piecesToImage, toBoard: invert(piecesToImage) };
	const support = corners && (photographed || center) ? supportedCorners(toBoard, corners, pic, toImage, squares, photographed) : undefined; // prettier-ignore
	return { toImage, toBoard, pieces, squares, perspective: true, cornerSupport: support?.supported, measuredCornerSupport: support?.measured, ...(center ? { embedded: true as const } : {}) }; // prettier-ignore
}

/** Detected intersections, supplemented by local contrast where photographic lighting hides them. */
function supportedCorners(
	toBoard: Homography,
	corners: Point[],
	pic?: Picture,
	toImage?: Homography,
	squares?: Square[],
	photographed = false,
): { supported: ReadonlySet<string>; measured: ReadonlySet<string> } {
	const supported = new Set<string>();
	let measured: ReadonlySet<string> = supported;
	for (const corner of corners) {
		const [column, row] = project(toBoard, ...corner);
		const [c, r] = [Math.round(column), Math.round(row)];
		if (Math.abs(column - c) < 0.18 && Math.abs(row - r) < 0.18) supported.add(`${c},${r}`); // prettier-ignore
	}
	if (pic && toImage && squares) {
		const checked = new Set<string>();
		for (const { column, row } of squares) {
			for (const [c, r] of [
				[column, row],
				[column + 1, row],
				[column, row + 1],
				[column + 1, row + 1],
			]) {
				const key = `${c},${r}`;
				if (supported.has(key) || checked.has(key)) continue;
				checked.add(key);
				if (localCheckerCorner(pic, toImage, c!, r!, photographed)) supported.add(key);
			}
		}
		measured = new Set(supported);
		// Fill small interior gaps from a snapshot, without growing one-sided viewport edges.
		for (let pass = 0; pass < 2; pass++) {
			const inferred: string[] = [];
			for (const key of checked) {
				if (supported.has(key)) continue;
				const [c, r] = key.split(',').map(Number) as Point;
				const near = [
					[c + 1, r],
					[c - 1, r],
					[c, r + 1],
					[c, r - 1],
				];
				if (near.filter(([x, y]) => supported.has(`${x},${y}`)).length >= 3) inferred.push(key); // prettier-ignore
			}
			for (const key of inferred) supported.add(key);
		}
		if (photographed) {
			const inferred: string[] = [];
			for (const key of checked) {
				if (supported.has(key)) continue;
				const [c, r] = key.split(',').map(Number) as Point;
				let neighbors = 0;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						if ((dx || dy) && supported.has(`${c + dx},${r + dy}`)) neighbors++;
					}
				}
				if (neighbors >= 5) inferred.push(key);
			}
			for (const key of inferred) supported.add(key);
		}
	}
	return { supported, measured };
}

/** Local quadrant colors find intersections in bright or shadowed areas outside the global palette. */
function localCheckerCorner(
	pic: Picture,
	toImage: Homography,
	column: number,
	row: number,
	photographed: boolean,
): boolean {
	for (const radius of photographed ? [2, 3] : [0, 1]) {
		for (const reach of photographed ? [0.08, 0.12, 0.2] : [0.18, 0.28]) {
			const a = colorNear(pic, toImage, column - reach, row - reach, radius);
			const b = colorNear(pic, toImage, column + reach, row - reach, radius);
			const c = colorNear(pic, toImage, column + reach, row + reach, radius);
			const d = colorNear(pic, toImage, column - reach, row + reach, radius);
			if (!a || !b || !c || !d) continue;
			const variation = Math.max(colorDistance(a, c), colorDistance(b, d));
			const contrast = Math.min(colorDistance(a, b), colorDistance(c, d));
			if (variation < 0.1 && contrast > Math.max(0.1, 2 * variation)) return true;
		}
	}
	return false;
}

/** Average display pixels around a projected point to suppress a photograph's subpixel stripes. */
function colorNear(
	pic: Picture,
	toImage: Homography,
	column: number,
	row: number,
	radius: number,
	out: RGB = [0, 0, 0],
): RGB | undefined {
	const w = toImage[6]! * column + toImage[7]! * row + toImage[8]!;
	const x = Math.floor((toImage[0]! * column + toImage[1]! * row + toImage[2]!) / w);
	const y = Math.floor((toImage[3]! * column + toImage[4]! * row + toImage[5]!) / w);
	if (x < radius || y < radius || x >= pic.width - radius || y >= pic.height - radius) return undefined; // prettier-ignore
	const stride = (pic.width + 1) * 3;
	const side = 2 * radius + 1;
	const a = (y - radius) * stride + (x - radius) * 3;
	const b = a + side * 3;
	const c = a + side * stride;
	const d = c + side * 3;
	const area = side * side;
	out[0] = (pic.sat[d]! - pic.sat[b]! - pic.sat[c]! + pic.sat[a]!) / area;
	out[1] = (pic.sat[d + 1]! - pic.sat[b + 1]! - pic.sat[c + 1]! + pic.sat[a + 1]!) / area;
	out[2] = (pic.sat[d + 2]! - pic.sat[b + 2]! - pic.sat[c + 2]! + pic.sat[a + 2]!) / area;
	return out;
}

/** A square, if it's fully on screen and large enough to read. */
function readableSquare(
	pic: Picture,
	toImage: Homography,
	toBoard: Homography,
	column: number,
	row: number,
): Square | undefined {
	for (const [c, r] of [
		[column, row],
		[column + 1, row],
		[column, row + 1],
		[column + 1, row + 1],
	] as Point[]) {
		if (!isInFront(toImage, c, r)) return undefined;
		const [x, y] = project(toImage, c, r);
		const outside = x < -EDGE_TOLERANCE || y < -EDGE_TOLERANCE || x > pic.width + EDGE_TOLERANCE || y > pic.height + EDGE_TOLERANCE; // prettier-ignore
		if (outside) return undefined;
	}
	const size = 1 / stretch(toBoard, ...project(toImage, column + 0.5, row + 0.5));
	return size >= MIN_SQUARE_SIZE ? { column, row, size } : undefined;
}
