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
	/** Coarsely averaged center, separating sky from a photographed display's pixel stripes. */
	skyBackground: RGB;
	skyVariation: number;
	/** A uniformly dark square can be a void, or sky beyond the world border. */
	void: boolean;
}

/** The squares of the board that show, and what borders them. */
export interface BoardRegion {
	/** Fully visible squares, including internal voids. */
	squares: Square[];
	/** Interior cells whose glyph or highlight hides the tile perimeter. */
	candidates: Square[];
	/** Bounded holes supported by their neighbors, requiring independent interior structure. */
	inferred?: ReadonlySet<string>;
	/** Number of orthogonal neighbors supported by tiles, sky, or the repeated island structure. */
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
	let darkParity: 0 | 1 = votes >= 0 ? 0 : 1;
	const index = new Map(surfaces.map((surface) => [key(surface.square), surface]));
	const initialEvidence = new Map(
		surfaces.map((surface) => [key(surface.square), surface.tiles]),
	);
	let gaps = new Set<string>();
	let crowdedPalette = false;
	if (tiles.photographed) {
		const measuredTiles = new Set(
			surfaces
				.filter(
					({ square }) =>
						view.measuredCornerSupport &&
						squareCorners(square).filter((k) => view.measuredCornerSupport!.has(k))
							.length >= 3,
				)
				.map(({ square }) => key(square)),
		);
		const locallyTiled = (square: Square): boolean => measuredTiles.has(key(square));
		// Repeated marks can dominate the global palette. The measured tile crossings still
		// determine which parity is darker from neighboring perimeter colors.
		let localVotes = 0;
		let comparisons = 0;
		for (const surface of surfaces) {
			if (!locallyTiled(surface.square) || surface.void) continue;
			for (const k of neighbors(surface.square)) {
				const neighbor = index.get(k);
				if (!neighbor || neighbor.void || !locallyTiled(neighbor.square)) continue;
				localVotes +=
					(luminance(neighbor.background) - luminance(surface.background)) *
					(parity(surface.square) === 0 ? 1 : -1);
				comparisons++;
			}
		}
		const localParity = localVotes >= 0 ? 0 : 1;
		const observed: [RGB[], RGB[]] = [[], []];
		for (const surface of surfaces) {
			if (locallyTiled(surface.square) && !surface.void)
				observed[parity(surface.square) === localParity ? 0 : 1].push(surface.background);
		}
		if (
			comparisons >= 16 &&
			Math.abs(localVotes) > 0.5 &&
			observed.every((colors) => colors.length >= 8)
		) {
			const recovered = observed.map(medianColor) as [RGB, RGB];
			crowdedPalette =
				colorDistance(recovered[0], tiles[0]) > 0.2 &&
				colorDistance(recovered[1], tiles[1]) < 0.15;
			if (crowdedPalette) darkParity = localParity;
		}
		const initialTiles = new Set(surfaces.filter((s) =>
			!s.void && (s.tiles[parity(s.square) === darkParity ? 0 : 1] > 0.3 || locallyTiled(s.square)),
		).map((s) => key(s.square))); // prettier-ignore
		gaps = findVoidLanes(surfaces, initialTiles);
		// Camera exposure can weaken a gray theme's contrast. Compare the local pair with the
		// recovered theme while keeping enough separation to reject a uniform foreground.
		const minimumContrast = crowdedPalette ? 0.035 : Math.max(0.05, Math.min(0.08, 0.5 * (luminance(tiles[1]) - luminance(tiles[0])))); // prettier-ignore
		const localSeeds = new Set(
			surfaces
				.filter(
					(neighbor) =>
						!neighbor.void &&
						(gaps.size > 0 ||
							locallyTiled(neighbor.square) ||
							((!crowdedPalette ||
								initialEvidence.get(key(neighbor.square))![
									parity(neighbor.square) === darkParity ? 0 : 1
								] > 0.3) &&
								neighbors(neighbor.square).some((k) => {
									const opposite = index.get(k);
									return (
										opposite &&
										initialEvidence.get(k)![
											parity(opposite.square) === darkParity ? 0 : 1
										] > 0.3
									);
								}))),
				)
				.map(({ square }) => key(square)),
		);
		for (const surface of surfaces) {
			const nearby: [RGB[], RGB[]] = [[], []];
			for (let dr = -3; dr <= 3; dr++) {
				for (let dc = -3; dc <= 3; dc++) {
					const neighbor = index.get(
						`${surface.square.column + dc},${surface.square.row + dr}`,
					);
					if (neighbor && localSeeds.has(key(neighbor.square)))
						nearby[parity(neighbor.square) === darkParity ? 0 : 1].push(
							neighbor.background,
						);
				}
			}
			if (nearby.some((group) => group.length < 3)) continue;
			const local: Tiles = [medianColor(nearby[0]), medianColor(nearby[1])];
			if (
				luminance(local[1]) - luminance(local[0]) <
					(gaps.size > 0 ? 0.04 : minimumContrast) ||
				(gaps.size === 0 && luminance(local[0]) < luminance(tiles[0]) - 0.18)
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
	if (tiles.photographed) for (const k of findVoidLanes(surfaces, tileSupported)) gaps.add(k);
	// A flat foreground can cover adjacent tile and sky interiors while leaving their edges.
	// Matching center colors across that boundary, unlike either exposed perimeter, reveal it.
	const foreground = new Set(
		tiles.photographed
			? surfaces
					.filter(
						(s) =>
							s.skyVariation < 0.14 &&
							colorDistance(s.skyBackground, s.background) > 0.12 &&
							neighbors(s.square).some((k) => {
								const neighbor = index.get(k);
								return (
									neighbor &&
									!neighbor.void &&
									Math.max(...neighbor.tiles) < 0.1 &&
									neighbor.skyVariation < 0.14 &&
									colorDistance(s.skyBackground, neighbor.skyBackground) <
										0.035 &&
									colorDistance(neighbor.skyBackground, neighbor.background) >
										0.08
								);
							}),
					)
					.map((s) => key(s.square))
			: [],
	);
	const supported = new Set(
		surfaces
			.filter((s) => {
				if (foreground.has(key(s.square))) return false;
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
					(s.sides[side] < 0.4 ||
						(s.cornerEvidence[side] < 3 &&
							!(s.sides[side] >= 0.6 && s.cornerEvidence[side] >= 2)))
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
	// The corner detector need not observe every crossing under smoothly varying camera light.
	// Four independently exposed tile perimeters also establish a crossing: opposite quadrants
	// must agree and adjacent quadrants must alternate. Only surfaces that have passed the
	// foreground checks can contribute, so rejected evidence cannot propagate to another cell.
	const surfaceCorners = tiles.photographed
		? inferredSurfaceCorners(surfaces, index, supported, darkParity)
		: new Set<string>();
	const cornerSupport = view.cornerSupport && new Set([...view.cornerSupport, ...surfaceCorners]);
	// A menu can share the light tiles' color. Its missing alternating neighbors distinguish it
	// from a board, even when it covers only empty squares.
	const tiled = surfaces.filter(({ square }) => {
		if (!supported.has(key(square))) return false;
		const adjacent = neighbors(square);
		const count = adjacent.filter((k) => supported.has(k)).length;
		if (count >= 2) return true;
		const surface = index.get(key(square))!;
		const side = parity(square) === darkParity ? 0 : 1;
		return (
			gaps.size > 0 &&
			count >= 1 &&
			adjacent.filter((k) => index.get(k)?.void).length >= 2 &&
			surface.variation < 0.14 &&
			surface.sides[side] >= 0.6 &&
			surface.cornerEvidence[side] >= 3
		);
	});
	if (tiled.length === 0) throw new Error('No board squares found in the image.');
	const columns = tiled.map(({ square }) => square.column);
	const rows = tiled.map(({ square }) => square.row);
	const [left, right] = [Math.min(...columns), Math.max(...columns)];
	const [top, bottom] = [Math.min(...rows), Math.max(...rows)];
	const inside = ({ column, row }: Square): boolean =>
		column >= left && column <= right && row >= top && row <= bottom;
	const skySides = [false, false, false, false];
	if (tiles.photographed) {
		for (const surface of surfaces) {
			const { column, row } = surface.square;
			if (
				!surface.void ||
				inside(surface.square) ||
				!neighbors(surface.square).some((k) => supported.has(k))
			)
				continue;
			if (row >= top && row <= bottom) {
				if (column < left) skySides[0] = true;
				if (column > right) skySides[1] = true;
			}
			if (column >= left && column <= right) {
				if (row < top) skySides[2] = true;
				if (row > bottom) skySides[3] = true;
			}
		}
	}
	const boundedBySky = skySides.every(Boolean);
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
					!(
						gaps.size > 0 &&
						surface.variation < 0.14 &&
						surface.sides[side] >= 0.6 &&
						surface.cornerEvidence[side] >= 3
					) &&
					neighbors(square).filter((k) => supported.has(k) || index.get(k)?.void).length <
						3
				)
					return false;
				if (!view.cornerSupport || (!tiles.photographed && !view.embedded)) return true;
				const corners = squareCorners(square).map((k) => cornerSupport!.has(k));
				return (
					(corners[0] && corners[3]) ||
					(corners[1] && corners[2]) ||
					(tiles.photographed &&
						edge &&
						(crowdedPalette || boundedBySky) &&
						surface.sides[side] >= 0.6 &&
						surface.cornerEvidence[side] >= 2 &&
						neighbors(square).filter((k) => supported.has(k)).length >= 2) ||
					(gaps.size > 0 &&
						surface.sides[side] >= 0.5 &&
						surface.variation < 0.14 &&
						surface.cornerEvidence[side] >= 3) ||
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
						gaps.has(key(s.square)) ||
						(neighbors(s.square).filter((k) => visible.has(k)).length >= 3 &&
							view.cornerSupport &&
							squareCorners(s.square).every((k) => view.cornerSupport!.has(k))))),
		)
		.map(({ square }) => square);
	if (crowdedPalette) {
		const exposed = tiled
			.filter((s) => parity(s.square) === darkParity)
			.map((s) => s.background);
		const localDark = exposed.length ? medianColor(exposed) : undefined;
		// A repeated glyph's gray can replace the dim tile color in the global palette.
		// Compare sky at a validated outer edge with the exposed tile perimeter itself.
		for (const surface of surfaces) {
			if (
				localDark &&
				!inside(surface.square) &&
				surface.skyVariation < 0.14 &&
				luminance(surface.skyBackground) < 0.8 * luminance(localDark) &&
				neighbors(surface.square).some((k) => visible.has(k))
			)
				surface.void = true;
		}
	}
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
	const enclosed = tiles.photographed
		? enclosedSurfaceHoles(surfaces, index, included, foreground, inside)
		: new Set<string>();
	const inferred = new Set<string>();
	const candidates =
		!view.perspective || tiles.photographed
			? surfaces
					.filter((surface) => {
						const { square } = surface;
						if (
							!inside(square) ||
							included.has(key(square)) ||
							foreground.has(key(square))
						)
							return false;
						if (!tiles.photographed || gaps.size > 0 || crowdedPalette) return true;
						// Missing crossings can span adjacent cells. Their component must be
						// enclosed by observed board surface before the independent appearance
						// model may examine its contents. Foreground and viewport edges are open.
						if (enclosed.has(key(square))) {
							inferred.add(key(square));
							return true;
						}
						const edge =
							square.column === left ||
							square.column === right ||
							square.row === top ||
							square.row === bottom;
						if (!edge) return false;
						const side = parity(square) === darkParity ? 0 : 1;
						return (
							surface.tiles[side] >= 0.6 &&
							surface.sides[side] >= 0.4 &&
							surface.cornerEvidence[side] >= 2
						);
					})
					.map(({ square }) => square)
			: [];
	const neighborCounts = new Map(
		candidates.map((square) => [
			key(square),
			neighbors(square).filter(
				(k) =>
					supported.has(k) ||
					index.get(k)?.void ||
					(gaps.size > 0 && index.has(k) && inside(index.get(k)!.square)),
			).length,
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
	return {
		squares,
		candidates,
		inferred,
		neighbors: neighborCounts,
		beyond,
		voids,
		darkParity,
		extent,
	};
}

/** Missing-cell components whose entire boundary is independently visible board surface. */
function enclosedSurfaceHoles(
	surfaces: Surface[],
	index: Map<string, Surface>,
	visible: Set<string>,
	foreground: Set<string>,
	inside: (square: Square) => boolean,
): Set<string> {
	const visited = new Set<string>();
	const enclosed = new Set<string>();
	for (const { square } of surfaces) {
		const start = key(square);
		if (visited.has(start) || visible.has(start) || foreground.has(start) || !inside(square))
			continue;
		const component = [start];
		visited.add(start);
		let bounded = true;
		for (let next = 0; next < component.length; next++) {
			for (const k of neighbors(index.get(component[next]!)!.square)) {
				if (visible.has(k)) continue;
				const neighbor = index.get(k);
				if (!neighbor || !inside(neighbor.square) || foreground.has(k)) {
					bounded = false;
					continue;
				}
				if (visited.has(k)) continue;
				visited.add(k);
				component.push(k);
			}
		}
		if (bounded) for (const k of component) enclosed.add(k);
	}
	return enclosed;
}

/** Crossings established by the alternating backgrounds of four exposed neighboring tiles. */
function inferredSurfaceCorners(
	surfaces: Surface[],
	index: Map<string, Surface>,
	tiled: Set<string>,
	darkParity: 0 | 1,
): Set<string> {
	const supported = new Set<string>();
	for (const { square } of surfaces) {
		const { column, row } = square;
		const quadrants = [
			index.get(`${column - 1},${row - 1}`),
			index.get(`${column},${row - 1}`),
			index.get(`${column},${row}`),
			index.get(`${column - 1},${row}`),
		];
		if (
			!quadrants.every(
				(s) =>
					s &&
					tiled.has(key(s.square)) &&
					s.sides[parity(s.square) === darkParity ? 0 : 1] >= 0.4 &&
					s.cornerEvidence[parity(s.square) === darkParity ? 0 : 1] >= 2,
			)
		)
			continue;
		const [a, b, c, d] = quadrants.map((s) => s!.background) as [RGB, RGB, RGB, RGB];
		const variation = Math.max(colorDistance(a, c), colorDistance(b, d));
		const contrast = Math.min(colorDistance(a, b), colorDistance(c, d));
		if (contrast > Math.max(0.04, 1.5 * variation)) supported.add(`${column},${row}`);
	}
	return supported;
}

/**
 * Repeated, crossing lanes of sky distinguish separated board islands from a foreground panel.
 * A photograph can tint sky differently from the tiles, and decorations can interrupt a few
 * samples. Require multiple regularly spaced lanes in both directions before accepting them.
 */
function findVoidLanes(surfaces: Surface[], tiled: Set<string>): Set<string> {
	const supported = surfaces.filter((s) => tiled.has(key(s.square)));
	if (supported.length === 0) return new Set();
	const columns = supported.map((s) => s.square.column);
	const rows = supported.map((s) => s.square.row);
	const [left, right] = [Math.min(...columns), Math.max(...columns)];
	const [top, bottom] = [Math.min(...rows), Math.max(...rows)];
	const index = new Map(surfaces.map((s) => [key(s.square), s]));
	const brightnesses = new Map<Surface, number>();
	const nearbyTileBrightness = (s: Surface): number => {
		const cached = brightnesses.get(s);
		if (cached !== undefined) return cached;
		let brightest = -Infinity;
		for (let dr = -2; dr <= 2; dr++) {
			for (let dc = -2; dc <= 2; dc++) {
				const k = `${s.square.column + dc},${s.square.row + dr}`;
				if (tiled.has(k))
					brightest = Math.max(brightest, luminance(index.get(k)!.background));
			}
		}
		brightnesses.set(s, brightest);
		return brightest;
	};
	const sky = (s: Surface | undefined): boolean =>
		!!s &&
		!tiled.has(key(s.square)) &&
		s.skyVariation < 0.14 &&
		luminance(s.skyBackground) < nearbyTileBrightness(s) - 0.15;
	const laneRows: number[] = [];
	const laneColumns: number[] = [];
	for (let row = top + 1; row < bottom; row++) {
		let count = 0;
		for (let column = left; column <= right; column++)
			if (sky(index.get(`${column},${row}`))) count++;
		if (count >= 0.8 * (right - left + 1)) laneRows.push(row);
	}
	for (let column = left + 1; column < right; column++) {
		let count = 0;
		for (let row = top; row <= bottom; row++) if (sky(index.get(`${column},${row}`))) count++;
		if (count >= 0.8 * (bottom - top + 1)) laneColumns.push(column);
	}
	const recover = (lanes: number[], from: number, to: number): number[] => {
		let best: number[] = [];
		let period = 0;
		for (let i = 0; i < lanes.length; i++) {
			for (let j = i + 1; j < lanes.length; j++) {
				const step = lanes[j]! - lanes[i]!;
				if (step < 3) continue;
				const aligned = lanes.filter((v) => (v - lanes[i]!) % step === 0);
				const expected = (aligned.at(-1)! - aligned[0]!) / step + 1;
				if (aligned.length < 0.6 * expected || aligned.length <= best.length) continue;
				best = aligned;
				period = step;
			}
		}
		if (best.length < 2) return [];
		const result: number[] = [];
		for (let value = from + 1; value < to; value++)
			if ((value - best[0]!) % period === 0) result.push(value);
		return result;
	};
	const rowGaps = recover(laneRows, top, bottom);
	const columnGaps = recover(laneColumns, left, right);
	if (rowGaps.length < 2 || columnGaps.length < 2) return new Set();
	const rowGapSet = new Set(rowGaps);
	const columnGapSet = new Set(columnGaps);
	const laneSky = new Map(
		surfaces
			.filter(
				(s) => (rowGapSet.has(s.square.row) || columnGapSet.has(s.square.column)) && sky(s),
			)
			.map((s) => [key(s.square), s]),
	);
	const gaps = new Set<string>();
	for (const s of surfaces) {
		const { column, row } = s.square;
		const inside = column >= left && column <= right && row >= top && row <= bottom;
		if (inside && (rowGapSet.has(row) || columnGapSet.has(column))) {
			if (tiled.has(key(s.square))) continue;
			if (luminance(s.skyBackground) >= nearbyTileBrightness(s) - 0.08) continue;
			const near: Surface[] = [];
			for (let dr = -2; dr <= 2; dr++) {
				for (let dc = -2; dc <= 2; dc++) {
					const neighbor = laneSky.get(`${column + dc},${row + dr}`);
					if (neighbor) near.push(neighbor);
				}
			}
			if (near.length < 2) continue;
			const skyColor = medianColor(near.map((n) => n.skyBackground));
			if (colorDistance(s.skyBackground, skyColor) > 0.12) {
				// The site's sky contains translucent squares in the board theme's colors.
				// They brighten a cell's center while its perimeter still exposes the sky.
				if (colorDistance(s.background, skyColor) > 0.12) continue;
				let decoration = false;
				for (let dr = -2; dr <= 2; dr++) {
					for (let dc = -2; dc <= 2; dc++) {
						const k = `${column + dc},${row + dr}`;
						if (!tiled.has(k)) continue;
						const color = index.get(k)!.background;
						const direction = color.map((v, c) => v - skyColor[c]!);
						const length = direction.reduce((sum, v) => sum + v * v, 0);
						const blend = direction.reduce((sum, v, c) => sum + v * (s.skyBackground[c]! - skyColor[c]!), 0) / length; // prettier-ignore
						const expected = skyColor.map((v, c) => v + blend * direction[c]!) as RGB;
						if (blend > 0 && blend < 0.8 && colorDistance(s.skyBackground, expected) < 0.06) decoration = true; // prettier-ignore
					}
				}
				if (!decoration) continue;
			}
			s.void = true;
			gaps.add(key(s.square));
		} else if (!inside && sky(s)) s.void = true;
	}
	return gaps;
}

/** Tile-colored perimeter samples avoid the pieces in a square's interior. */
function surfaceOf(pic: Picture, view: View, square: Square, tiles: Tiles): Surface {
	const samples = Math.min(24, Math.max(8, Math.round(square.size / (tiles.photographed ? 2 : 1)))); // prettier-ignore
	const margin = square.size >= 14 && (!tiles.photographed || square.size >= 30) ? 0.04 : 0;
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
	const background = medianColor(sides.flat());
	let skyBackground = background;
	let skyVariation = variation;
	if (tiles.photographed) {
		const skyPatch = samplePatch(
			pic,
			view.toImage,
			[square.column + 0.2, square.row + 0.2],
			0.6,
			4,
		);
		const skyColors = Array.from({ length: 16 }, (_, i): RGB => [
			skyPatch[i * 3]!,
			skyPatch[i * 3 + 1]!,
			skyPatch[i * 3 + 2]!,
		]);
		const skyBrightnesses = skyColors.map(luminance).sort((a, b) => a - b);
		skyBackground = medianColor(skyColors);
		skyVariation = skyBrightnesses[15]! - skyBrightnesses[0]!;
	}
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
		background,
		perimeter: sides,
		sides: sideEvidence.sides,
		corners,
		cornerEvidence: cornerEvidence(corners, tiles, tolerance),
		variation,
		skyBackground,
		skyVariation,
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
