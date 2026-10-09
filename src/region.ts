/**
 * Which of the board's squares show. Nothing covers most screenshots, which show every square up to
 * the world border. Menus, the browser around the board or things in front of a photographed
 * screen can leave holes in the board, or several islands of it, each square judged on its own.
 */

import type { RGB } from './color.js';
import type { Picture } from './picture.js';
import type { Tiles } from './tiles.js';
import type { Square, View } from './view.js';
import type { Extent } from './board.js';
import type { SampledSquare } from './matcher.js';

import { colorDistance, luminance } from './color.js';
import { samplePatch } from './picture.js';
import { isTileColor, isVoidColor } from './tiles.js';
import { findBoardExtent, findDarkParity, isWithin } from './board.js';

// Types -----------------------------------------------------------------------

/** What a square's sampled surface shows of the tiles, at its edges and inside. */
interface Surface {
	square: Square;
	/** Fraction of the perimeter showing each tile color. */
	tiles: [number, number];
	background: RGB;
	perimeter: RGB[][];
	sides: [number, number];
	corners: RGB[];
	cornerEvidence: [number, number];
	/** Interior luminance range, with photographic display noise outliers removed. */
	variation: number;
	/** A uniformly dark square can be a void, or sky beyond the world border. */
	void: boolean;
}

/** The squares of the board that show, and what borders them. */
export interface BoardRegion {
	/** Fully visible squares, including internal voids. */
	squares: Square[];
	/** Interior cells whose glyph or highlight hides the tile perimeter. */
	candidates: Square[];
	/** Number of directly supported orthogonal neighbors of an interior candidate. */
	neighbors: Map<string, number>;
	/** Uniform dark squares outside the tile extent, which can establish a world border. */
	beyond: Square[];
	/** Squares whose surface is uniformly dark rather than merely in photographic shadow. */
	voids: Set<string>;
	/** Which parity of column + row the dark tiles sit on. */
	darkParity: 0 | 1;
	/** Extent of the locally validated tile surface, excluding voids and sky. */
	extent: Extent;
}

// Constants -------------------------------------------------------------------

/** How many plain squares showing something other than the board count as it being covered. */
const OBSTRUCTED_SQUARES = 2;

// Functions -------------------------------------------------------------------

/** Whether something covers part of the board, by plain squares showing neither their tile, a void nor sky. */
export function isObstructed(sampled: SampledSquare[], tiles: Tiles): boolean {
	const darkParity = findDarkParity(sampled, tiles);
	const foreign = sampled.filter(({ square, patch, mean }) => !patch && !showsBoard(square, mean, tiles, darkParity)); // prettier-ignore
	return foreign.length >= OBSTRUCTED_SQUARES;
}

/** Whether a plain square shows what the board would there: its own tile, a void, or the sky. */
function showsBoard(square: Square, mean: RGB, tiles: Tiles, darkParity: 0 | 1): boolean {
	if (isVoidColor(mean, tiles)) return true;
	if (!isTileColor(mean, tiles)) return false;
	const isDark = colorDistance(mean, tiles[0]) < colorDistance(mean, tiles[1]);
	return isDark === (parity(square) === darkParity);
}

/** The region of a board nothing covers: every square up to its world border. */
export function openRegion(sampled: SampledSquare[], tiles: Tiles): BoardRegion {
	const extent = findBoardExtent(sampled, tiles);
	const onBoard = sampled.filter(({ square }) => isWithin(square, extent));
	return {
		squares: sampled.map(({ square }) => square),
		candidates: [],
		neighbors: new Map(),
		beyond: [],
		voids: new Set(),
		darkParity: findDarkParity(onBoard, tiles),
		extent,
	};
}

/** Finds the board surface without imposing a rectangular or connected visible region. */
export function findBoardRegion(pic: Picture, view: View, tiles: Tiles): BoardRegion {
	const surfaces = view.squares.map((square) => surfaceOf(pic, view, square, tiles));
	let votes = 0;
	for (const { square, tiles: evidence } of surfaces) {
		votes += (evidence[0] - evidence[1]) * (parity(square) === 0 ? 1 : -1);
	}
	const darkParity = votes >= 0 ? 0 : 1;
	const index = new Map(surfaces.map((surface) => [key(surface.square), surface]));
	const initialEvidence = new Map(
		surfaces.map((surface) => [key(surface.square), surface.tiles]),
	);
	if (tiles.photographed) {
		// Camera exposure can weaken a gray theme's contrast. Compare the local pair with the
		// recovered theme while keeping enough separation to reject a uniform foreground.
		const minimumContrast = Math.max(0.05, Math.min(0.08, 0.5 * (luminance(tiles[1]) - luminance(tiles[0])))); // prettier-ignore
		for (const surface of surfaces) {
			const nearby: [RGB[], RGB[]] = [[], []];
			for (let dr = -3; dr <= 3; dr++) {
				for (let dc = -3; dc <= 3; dc++) {
					const neighbor = index.get(
						`${surface.square.column + dc},${surface.square.row + dr}`,
					);
					if (
						neighbor &&
						!neighbor.void &&
						neighbors(neighbor.square).some((k) => {
							const opposite = index.get(k);
							return (
								opposite &&
								initialEvidence.get(k)![
									parity(opposite.square) === darkParity ? 0 : 1
								] > 0.3
							);
						})
					)
						nearby[parity(neighbor.square) === darkParity ? 0 : 1].push(
							neighbor.background,
						);
				}
			}
			if (nearby.some((group) => group.length < 3)) continue;
			const local: Tiles = [medianColor(nearby[0]), medianColor(nearby[1])];
			if (
				luminance(local[1]) - luminance(local[0]) < minimumContrast ||
				luminance(local[0]) < luminance(tiles[0]) - 0.18
			) {
				surface.tiles = [0, 0];
				continue;
			}
			const evidence = perimeterEvidence(surface.perimeter, local, 0.24);
			surface.tiles = evidence.tiles;
			surface.sides = evidence.sides;
			surface.cornerEvidence = cornerEvidence(surface.corners, local, 0.24);
		}
	}
	const tileSupported = new Set(
		surfaces
			.filter(
				(s) =>
					s.tiles[parity(s.square) === darkParity ? 0 : 1] >=
					(s.square.size < 14 ? 0.05 : 0.4),
			)
			.map((s) => key(s.square)),
	);
	const supported = new Set(
		surfaces
			.filter((s) => {
				const side = parity(s.square) === darkParity ? 0 : 1;
				const nearUi = neighbors(s.square).some(
					(k) => index.has(k) && !tileSupported.has(k) && !index.get(k)!.void,
				);
				// Wires and other foreground fragments can resemble glyphs while leaving the
				// grid corners visible. A busy cell beside an occlusion must show the tile on
				// every side as well as at its corners.
				if (
					tiles.photographed &&
					nearUi &&
					s.variation >= 0.14 &&
					(s.sides[side] < 0.4 || s.cornerEvidence[side] < 3)
				)
					return false;
				return (
					tileSupported.has(key(s.square)) &&
					(view.perspective ||
						!nearUi ||
						s.square.size < 14 ||
						s.cornerEvidence[side] >= 3)
				);
			})
			.map(({ square }) => key(square)),
	);
	// A menu can share the light tiles' color. Its missing alternating neighbors distinguish it
	// from a board, even when it covers only empty squares.
	const tiled = surfaces.filter(({ square }) => {
		if (!supported.has(key(square))) return false;
		return neighbors(square).filter((k) => supported.has(k)).length >= 2;
	});
	if (tiled.length === 0) throw new Error('No board squares found in the image.');
	const columns = tiled.map(({ square }) => square.column);
	const rows = tiled.map(({ square }) => square.row);
	const [left, right] = [Math.min(...columns), Math.max(...columns)];
	const [top, bottom] = [Math.min(...rows), Math.max(...rows)];
	const inside = ({ column, row }: Square): boolean =>
		column >= left && column <= right && row >= top && row <= bottom;
	const visible = new Set(
		tiled
			.filter(({ square }) => {
				const edge =
					square.column === left ||
					square.column === right ||
					square.row === top ||
					square.row === bottom;
				// A curved foreground or an application bar can make a genuine visible boundary
				// lie inside the bounding box. Four observed crossings and a uniform interior
				// support a bare tile with only two visible neighbors. Inferred crossings do not.
				const complete = tiles.photographed && view.measuredCornerSupport && squareCorners(square).every((k) => view.measuredCornerSupport!.has(k)); // prettier-ignore
				const surface = index.get(key(square))!;
				const side = parity(square) === darkParity ? 0 : 1;
				if (
					!edge &&
					!(complete && surface.variation < 0.14) &&
					neighbors(square).filter((k) => supported.has(k) || index.get(k)?.void).length <
						3
				)
					return false;
				if (!view.cornerSupport || (!tiles.photographed && !view.embedded)) return true;
				const corners = squareCorners(square).map((k) => view.cornerSupport!.has(k));
				return (
					(corners[0] && corners[3]) ||
					(corners[1] && corners[2]) ||
					(surface.sides[side] > 0.4 &&
						surface.cornerEvidence[side] >= 3 &&
						neighbors(square).some((k) => index.get(k)?.void))
				);
			})
			.map(({ square }) => key(square)),
	);
	const squares = surfaces
		.filter(
			(s) =>
				visible.has(key(s.square)) ||
				(s.void &&
					inside(s.square) &&
					(!tiles.photographed ||
						(neighbors(s.square).filter((k) => visible.has(k)).length >= 3 &&
							view.cornerSupport &&
							squareCorners(s.square).every((k) => view.cornerSupport!.has(k))))),
		)
		.map(({ square }) => square);
	let beyond = surfaces.filter((s) => s.void && !inside(s.square)).map(({ square }) => square);
	if (tiles.photographed) {
		beyond = beyond.filter((square) => neighbors(square).some((k) => visible.has(k)));
		if (beyond.length < 3) beyond = [];
	}
	const voids = new Set(
		surfaces
			.filter((s) => s.void && (!tiles.photographed || !visible.has(key(s.square))))
			.map(({ square }) => key(square)),
	);
	const included = new Set(squares.map(key));
	const candidates = !view.perspective
		? surfaces
				.filter(({ square }) => inside(square) && !included.has(key(square)))
				.map(({ square }) => square)
		: [];
	const neighborCounts = new Map(
		candidates.map((square) => [
			key(square),
			neighbors(square).filter((k) => supported.has(k) || index.get(k)?.void).length,
		]),
	);
	const tileSquares = surfaces
		.filter(({ square }) => visible.has(key(square)))
		.map(({ square }) => square);
	if (tileSquares.length === 0) throw new Error('No visible board squares found in the image.');
	const extent = {
		left: Math.min(...tileSquares.map((s) => s.column)),
		right: Math.max(...tileSquares.map((s) => s.column)),
		top: Math.min(...tileSquares.map((s) => s.row)),
		bottom: Math.max(...tileSquares.map((s) => s.row)),
	};
	return { squares, candidates, neighbors: neighborCounts, beyond, voids, darkParity, extent };
}

/** Tile-colored perimeter samples avoid the pieces in a square's interior. */
function surfaceOf(pic: Picture, view: View, square: Square, tiles: Tiles): Surface {
	const samples = Math.min(24, Math.max(8, Math.round(square.size)));
	const margin = square.size >= 14 ? 0.04 : 0;
	const patch = samplePatch(
		pic,
		view.toImage,
		[square.column + margin, square.row + margin],
		1 - 2 * margin,
		samples,
	);
	const evidence: [number, number] = [0, 0];
	const sides: RGB[][] = [[], [], [], []];
	let perimeter = 0;
	let dark = 0;
	let darkest = Infinity;
	let lightest = -Infinity;
	const mean: RGB = [0, 0, 0];
	let interior = 0;
	const brightnesses: number[] = [];
	const tolerance = tiles.photographed
		? 0.24
		: Math.max(0.05, Math.min(0.14, 0.3 * colorDistance(tiles[0], tiles[1])));
	for (let y = 0; y < samples; y++) {
		for (let x = 0; x < samples; x++) {
			const at = (y * samples + x) * 3;
			const color: RGB = [patch[at]!, patch[at + 1]!, patch[at + 2]!];
			const brightness = luminance(color);
			if (x > 0 && y > 0 && x < samples - 1 && y < samples - 1) {
				interior++;
				brightnesses.push(brightness);
				for (const channel of [0, 1, 2] as const) mean[channel] += color[channel];
				darkest = Math.min(darkest, brightness);
				lightest = Math.max(lightest, brightness);
				if (brightness < 0.8 * luminance(tiles[0])) dark++;
			}
			if (x !== 0 && y !== 0 && x !== samples - 1 && y !== samples - 1) continue;
			perimeter++;
			if (y === 0) sides[0]!.push(color);
			if (x === samples - 1) sides[1]!.push(color);
			if (y === samples - 1) sides[2]!.push(color);
			if (x === 0) sides[3]!.push(color);
			const distances = [colorDistance(color, tiles[0]), colorDistance(color, tiles[1])];
			const side = distances[0]! < distances[1]! ? 0 : 1;
			if (distances[side]! < tolerance) evidence[side]++;
		}
	}
	const ratios = mean.map(
		(value, channel) => value / interior / Math.max(0.05, tiles[0][channel]!),
	);
	brightnesses.sort((a, b) => a - b);
	const variation = brightnesses[Math.floor(interior * 0.95)]! - brightnesses[Math.floor(interior * 0.05)]!; // prettier-ignore
	const uniform = tiles.photographed
		? variation < 0.14 && dark >= 0.98 * interior
		: lightest - darkest < 0.04 && dark === interior;
	const sideEvidence = perimeterEvidence(sides, tiles, tolerance);
	const corners = [
		[0, 0],
		[samples - 1, 0],
		[0, samples - 1],
		[samples - 1, samples - 1],
	].map(([x, y]) => {
		const at = (y! * samples + x!) * 3;
		return [patch[at]!, patch[at + 1]!, patch[at + 2]!] as RGB;
	});
	return {
		square,
		tiles: [evidence[0] / perimeter, evidence[1] / perimeter],
		background: medianColor(sides.flat()),
		perimeter: sides,
		sides: sideEvidence.sides,
		corners,
		cornerEvidence: cornerEvidence(corners, tiles, tolerance),
		variation,
		void:
			uniform &&
			(Math.max(...ratios) - Math.min(...ratios) < 0.12 ||
				(!tiles.photographed && luminance(mean.map((v) => v / interior) as RGB) < 0.18)),
	};
}

/** How many of a square's corner samples show each tile color. */
function cornerEvidence(corners: RGB[], tiles: Tiles, tolerance: number): [number, number] {
	const counts: [number, number] = [0, 0];
	for (const color of corners) {
		const distances = [colorDistance(color, tiles[0]), colorDistance(color, tiles[1])];
		const side = distances[0]! < distances[1]! ? 0 : 1;
		if (distances[side]! < tolerance) counts[side]++;
	}
	return counts;
}

/** The per-channel median of some colors. */
function medianColor(colors: RGB[]): RGB {
	return [0, 1, 2].map(
		(channel) =>
			colors.map((color) => color[channel]!).sort((a, b) => a - b)[
				Math.floor(colors.length / 2)
			]!,
	) as RGB;
}

/** The fraction of a square's edge samples showing each tile color: on average, and on its barest side. */
function perimeterEvidence(
	sides: RGB[][],
	tiles: Tiles,
	tolerance: number,
): { tiles: [number, number]; sides: [number, number] } {
	const fractions = sides.map((colors) => {
		const counts: [number, number] = [0, 0];
		for (const color of colors) {
			const distances = [colorDistance(color, tiles[0]), colorDistance(color, tiles[1])];
			const side = distances[0]! < distances[1]! ? 0 : 1;
			if (distances[side]! < tolerance) counts[side]++;
		}
		return counts.map((count) => count / colors.length);
	});
	return {
		tiles: [0, 1].map(
			(side) => fractions.reduce((sum, f) => sum + f[side]!, 0) / fractions.length,
		) as [number, number],
		sides: [0, 1].map((side) => Math.min(...fractions.map((f) => f[side]!))) as [
			number,
			number,
		],
	};
}

/** Whether a square's column + row is even (0) or odd (1). */
function parity({ column, row }: Square): 0 | 1 {
	return (((column + row) % 2) + 2) % 2 === 0 ? 0 : 1;
}

/** A square's `column,row` key. */
function key({ column, row }: Square): string {
	return `${column},${row}`;
}

/** The keys of a square's four orthogonal neighbors. */
function neighbors({ column, row }: Square): string[] {
	return [
		`${column - 1},${row}`,
		`${column + 1},${row}`,
		`${column},${row - 1}`,
		`${column},${row + 1}`,
	];
}

/** The keys of a square's four corners, as grid intersections. */
function squareCorners({ column, row }: Square): string[] {
	return [
		`${column},${row}`,
		`${column + 1},${row}`,
		`${column},${row + 1}`,
		`${column + 1},${row + 1}`,
	];
}
