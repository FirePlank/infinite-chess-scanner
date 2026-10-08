/**
 * Where the board sits in a screenshot: the homography placing its grid, and the squares shown
 * well enough to read. A screenshot looking straight down gets its grid from the period of the
 * tile edges, exact to a negligible fraction of a pixel; one at an angle, from its corners.
 */

import type { Grid } from './grid.js';
import type { Picture } from './picture.js';
import type { Tiles } from './tiles.js';
import type { Homography, Point } from './homography.js';

import { EDGE_TOLERANCE, findGrid } from './grid.js';
import { colorDistance } from './color.js';
import { colorAt } from './picture.js';
import { isTileColor, tileShades } from './tiles.js';
import { findCorners, fitLattice } from './lattice.js';
import { invert, isInFront, project, stretch } from './homography.js';

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

/** How the board's grid sits in a screenshot. */
export interface View {
	/** Maps board-grid coordinates to image pixels: square (column, row) spans [column, column+1] x [row, row+1]. */
	toImage: Homography;
	toBoard: Homography;
	/** Every square fully on screen and large enough to read. */
	squares: Square[];
	/** Whether the board is seen at an angle. */
	perspective: boolean;
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

/** The most squares read at an angle, which keeps a view toward the horizon bounded. */
const MAX_SQUARES = 20000;

// Functions -------------------------------------------------------------------

/**
 * How the board's grid might sit in a screenshot. Seen at an angle, it can take two, one for each
 * way the pieces might stand, for the pieces themselves to tell apart.
 * @throws If there's no checkerboard, or its squares are too small to read.
 */
export function findViews(pic: Picture, tiles: Tiles): View[] {
	const shades = tileShades(pic, tiles);
	const corners = findCorners(pic, shades);
	let grid: Grid | undefined;
	let gridError: unknown;
	try {
		grid = findGrid(pic, shades);
	} catch (error) {
		gridError = error;
	}
	if (grid && isGridOnCorners(grid, corners)) return [flatView(grid)];
	const homographies = fitLattice(corners, pic.width, pic.height);
	if (homographies) {
		const views = homographies.map((toImage) => perspectiveView(pic, toImage));
		if (isCheckered(pic, tiles, views[0]!)) return views;
	}
	if (grid) return [flatView(grid)];
	throw gridError;
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
	return { toImage, toBoard: invert(toImage), squares, perspective: false };
}

/**
 * The view of a board seen at an angle: every readable square connected to the middle of its lattice.
 * @throws If none is large enough to read.
 */
function perspectiveView(pic: Picture, toImage: Homography): View {
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
	return { toImage, toBoard, squares, perspective: true };
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
		// prettier-ignore
		if (!isInFront(toImage, c, r)) return undefined;
		const [x, y] = project(toImage, c, r);
		const outside = x < -EDGE_TOLERANCE || y < -EDGE_TOLERANCE || x > pic.width + EDGE_TOLERANCE || y > pic.height + EDGE_TOLERANCE; // prettier-ignore
		if (outside) return undefined;
	}
	const size = 1 / stretch(toBoard, ...project(toImage, column + 0.5, row + 0.5));
	return size >= MIN_SQUARE_SIZE ? { column, row, size } : undefined;
}
