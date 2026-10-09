/**
 * Decides what each square holds: nothing, a void, or a piece. Candidates are ranked on sampled
 * patches, then the closest few are settled at pixel level, where look-alikes like the queen and
 * royal queen differ.
 */

import type { RGB } from './color.js';
import type { Fit, Matcher, SampledSquare, SizeClass } from './matcher.js';
import type { Picture } from './picture.js';
import type { Piece } from './pieces.js';
import type { MipLevel } from './sprites.js';
import type { Plane, Square, View } from './view.js';
import type { Tiles } from './tiles.js';

import { project } from './homography.js';
import {
	fitTemplate,
	glowAt,
	innerMask,
	isPhotographicBackground,
	isPlain,
	patchSums,
	photoBackground,
	rankFits,
	refinePhotoFits,
} from './matcher.js';
import { royalCounterpart } from './pieces.js';
import { isVoidColor } from './tiles.js';
import { sampleTexture, textureLod } from './sprites.js';

// Types -----------------------------------------------------------------------

/** Everything classifying one screenshot's squares needs. */
export interface Reader {
	pic: Picture;
	view: View;
	tiles: Tiles;
	/** Whether a square neither a piece nor the background explains reads as covered. */
	detectsCovers: boolean;
	/** Cells inferred across a small gap, whose interiors must independently prove visible structure. */
	inferred?: ReadonlySet<string>;
}

/** The screen pixels a square is compared over at pixel level, and where each falls in it. */
interface PixelSet {
	indices: Int32Array;
	u: Float32Array;
	v: Float32Array;
	/** The mipmap level the site samples the square's piece at. */
	lod: number;
	size: number;
}

/** What one square holds. */
export type Verdict =
	{ kind: 'empty' } | { kind: 'void' } | { kind: 'obscured' } | { kind: 'piece'; piece: Piece };

// Constants -------------------------------------------------------------------

/** A piece must leave at most this fraction of the residual of a bare background. */
const PIECE_FIT_RATIO = 0.8;

/** How many of a square's best-fitting pieces are compared again at pixel level. */
const FINALIST_COUNT = 3;

/** How many times worse than the best a candidate may fit and still be compared at pixel level. */
const FINALIST_MARGIN = 1.5;

/** Sub-pixel offsets the finalists are fit at, in pixels along each axis. */
const ALIGNMENT_OFFSETS = [-0.3, -0.15, 0, 0.15, 0.3];

/** Pixel-level fits compare at most this many pixels per square side, skipping between them. */
const MAX_PIXELS_PER_SIDE = 24;

/** How much redder than green and blue a fitted glow is when a royal is in check. */
const CHECK_GLOW_REDNESS = 0.15;

// Functions -------------------------------------------------------------------

/** Decides what a square holds, from its patch compared at its size class. */
export function classify(
	reader: Reader,
	{ square, sizeClass, mean, patch }: SampledSquare,
	matchers: (sizeClass: SizeClass) => Matcher,
): Verdict {
	const { tiles } = reader;
	if (patch === undefined || isPlain(patch, innerMask(sizeClass.samples))) return backgroundVerdict(mean, tiles); // prettier-ignore
	const matcher = matchers(sizeClass);
	if (matcher.photographed && reader.inferred?.has(`${square.column},${square.row}`)) {
		const background = photoBackground(patch, matcher.samples);
		// A conservative small-sample margin on four side blocks avoids assuming every
		// camera pixel independent; the blocks themselves can remain correlated.
		if (background.interior <= background.noise + 4.6 * background.noiseUncertainty)
			return { kind: 'obscured' };
	}
	if (matcher.photographed && isPhotographicBackground(patch, matcher.samples))
		return backgroundVerdict(mean, tiles);

	const sums = patchSums(matcher, patch);
	let ranked = rankFits(matcher, patch, sums);
	const background = fitTemplate(matcher.empty, matcher, patch, sums);
	if (matcher.photographed) {
		// Display stripes make bare tiles busy. A clean background fit that decisively beats
		// every glyph needs no expensive search over shifted photographic templates.
		if (
			ranked[0]!.residual >= 2 * background.residual &&
			background.residual <= 0.01 * matcher.compared
		)
			return backgroundVerdict(mean, tiles);
		const unaligned = ranked;
		ranked = refinePhotoFits(matcher, patch, sums, unaligned);
		const noise = ranked[0]!.noise ?? 0;
		// An unexplained shape beside independently measured tile corners can need a wider
		// correction for local grid drift when one sample spans less than two camera pixels.
		// It must already fit near the bare background, and improve materially after shifting.
		if (
			square.size < 2 * matcher.samples &&
			ranked[0]!.residual > PIECE_FIT_RATIO * background.residual &&
			ranked[0]!.residual <= 1.05 * background.residual &&
			noise <= 0.03 &&
			background.residual > 1.3 * noise * matcher.compared &&
			hasMeasuredCorners(reader.view, square)
		) {
			const wider = refinePhotoFits(matcher, patch, sums, unaligned, true);
			if (wider[0]!.residual < 0.8 * ranked[0]!.residual)
				ranked = [...ranked, ...wider].sort((a, b) => a.residual - b.residual);
		}
	}
	const samples = matcher.compared;
	const unexplained = matcher.photographed
		? 0.06 + 2 * Math.min(0.03, ranked[0]!.noise ?? 0)
		: 0.04;
	const unexplainedRatio = matcher.photographed ? 0.45 : PIECE_FIT_RATIO;
	if (
		reader.detectsCovers &&
		Math.min(ranked[0]!.residual, background.residual) > unexplained * samples &&
		ranked[0]!.residual > unexplainedRatio * background.residual
	) {
		return { kind: 'obscured' };
	}
	// Noise on a photographed bare tile remains even when its glyph fits exactly. Discount
	// that shared error, bounded so a poor glyph fit still needs visible shape evidence.
	const sharedNoise =
		matcher.photographed && (ranked[0]!.noise ?? 0) <= 0.03
			? Math.min(0.2 * background.residual, (ranked[0]!.noise ?? 0) * samples)
			: 0;
	if (ranked[0]!.residual - sharedNoise > PIECE_FIT_RATIO * (background.residual - sharedNoise))
		return backgroundVerdict(mean, tiles);
	const finalists = ranked
		.filter(
			(fit) =>
				!matcher.photographed ||
				fit.template.sprite!.piece.player === ranked[0]!.template.sprite!.piece.player,
		) // prettier-ignore
		.slice(0, FINALIST_COUNT)
		.filter((fit) => fit.residual <= FINALIST_MARGIN * ranked[0]!.residual);
	const best =
		!matcher.photographed && finalists.length > 1
			? settle(reader, square, finalists)
			: ranked[0]!;

	const piece = best.template.sprite!.piece;
	const royal = royalCounterpart(piece);
	// A camera's stripes can make the least-squares glow faintly red. Its uncertainty comes
	// from the independently measured bare-tile noise and the radial background basis.
	const { uu, uv, vv } = best.template;
	const ridge = 1e-3 * (uu + 1);
	const glowVariance = matcher.photographed
		? (0.5 * (best.noise ?? 0) * (uu + ridge)) / ((uu + ridge) * (vv + ridge) - uv * uv)
		: 0;
	const inCheck = best.glow[0] - (best.glow[1] + best.glow[2]) / 2 > CHECK_GLOW_REDNESS + 2 * Math.sqrt(glowVariance); // prettier-ignore
	return { kind: 'piece', piece: royal !== undefined && inCheck ? royal : piece };
}

/** At least three directly seen tile crossings support a wider local glyph correction. */
function hasMeasuredCorners(view: View, { column, row }: Square): boolean {
	return (
		[
			`${column},${row}`,
			`${column + 1},${row}`,
			`${column},${row + 1}`,
			`${column + 1},${row + 1}`,
		].filter((key) => view.measuredCornerSupport?.has(key)).length >= 3
	);
}

/** A pieceless square is a void when it's clearly darker than even the dark tiles. */
function backgroundVerdict(mean: RGB, tiles: Tiles): Verdict {
	return isVoidColor(mean, tiles) ? { kind: 'void' } : { kind: 'empty' };
}

/**
 * Picks among a square's closest candidates by refitting each at pixel level, at the sub-pixel
 * alignment that suits it best. Returns the winner's fit to the patch.
 */
function settle(reader: Reader, square: Square, finalists: Fit[]): Fit {
	const pixels = pixelsOf(reader.pic, reader.view.pieces, square);
	const residuals = finalists.map((fit) => alignedResidual(reader.pic, pixels, fit.template.sprite!.levels)); // prettier-ignore
	return finalists[residuals.indexOf(Math.min(...residuals))]!;
}

/**
 * A piece's lowest pixel-level residual over the alignment offsets. The residual falls steadily
 * toward the best alignment, so walking downhill from no offset finds it.
 */
function alignedResidual(pic: Picture, pixels: PixelSet, levels: MipLevel[]): number {
	const n = ALIGNMENT_OFFSETS.length;
	const residuals = new Map<number, number>();
	const at = (i: number, j: number): number => {
		if (i < 0 || j < 0 || i >= n || j >= n) return Infinity;
		const key = i * n + j;
		if (!residuals.has(key)) residuals.set(key, fitPixels(pic, pixels, levels, ALIGNMENT_OFFSETS[i]!, ALIGNMENT_OFFSETS[j]!)); // prettier-ignore
		return residuals.get(key)!;
	};
	let [i, j] = [(n - 1) / 2, (n - 1) / 2];
	for (;;) {
		let [bestI, bestJ] = [i, j];
		for (let di = -1; di <= 1; di++) {
			for (let dj = -1; dj <= 1; dj++) if (at(i + di, j + dj) < at(bestI, bestJ)) [bestI, bestJ] = [i + di, j + dj]; // prettier-ignore
		}
		if (bestI === i && bestJ === j) return at(i, j);
		[i, j] = [bestI, bestJ];
	}
}

/** The pixels a square is compared over: every few, within its margins. */
function pixelsOf(pic: Picture, plane: Plane, square: Square): PixelSet {
	const { column, row, size } = square;
	const margin = 1 / MAX_PIXELS_PER_SIDE + 0.5 / size;
	const step = Math.max(1, Math.floor(size / MAX_PIXELS_PER_SIDE));
	const corners = [project(plane.toImage, column, row), project(plane.toImage, column + 1, row), project(plane.toImage, column, row + 1), project(plane.toImage, column + 1, row + 1)]; // prettier-ignore
	const left = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[0]))));
	const right = Math.min(pic.width - 1, Math.ceil(Math.max(...corners.map((p) => p[0]))));
	const top = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[1]))));
	const bottom = Math.min(pic.height - 1, Math.ceil(Math.max(...corners.map((p) => p[1]))));
	const indices: number[] = [];
	const us: number[] = [];
	const vs: number[] = [];
	for (let py = top; py <= bottom; py += step) {
		for (let px = left; px <= right; px += step) {
			const [boardU, boardV] = project(plane.toBoard, px + 0.5, py + 0.5);
			const [u, v] = [boardU - column, boardV - row];
			if (u < margin || v < margin || u > 1 - margin || v > 1 - margin) continue;
			indices.push(py * pic.width + px);
			us.push(u);
			vs.push(v);
		}
	}
	const [u, v] = [Float32Array.from(us), Float32Array.from(vs)];
	return { indices: Int32Array.from(indices), u, v, lod: textureLod(size), size };
}

/**
 * The mean residual of {@link fitTemplate}'s model at pixel level: the piece rendered at every
 * compared screen pixel's own position in the square, shifted by a sub-pixel offset, against the
 * raw pixels. The same pixels are compared at every offset, only the piece shifts.
 */
function fitPixels(
	pic: Picture,
	pixels: PixelSet,
	levels: MipLevel[],
	offsetX: number,
	offsetY: number,
): number {
	const [shiftU, shiftV] = [offsetX / pixels.size, offsetY / pixels.size];
	const texel = new Float32Array(4);
	let uu = 0;
	let uv = 0;
	let vv = 0;
	let yy = 0;
	const uy: RGB = [0, 0, 0];
	const vy: RGB = [0, 0, 0];
	for (let p = 0; p < pixels.indices.length; p++) {
		const [u, v] = [pixels.u[p]! - shiftU, pixels.v[p]! - shiftV];
		sampleTexture(levels, pixels.lod, u, v, texel);
		const background = 1 - texel[3]!;
		const glow = background * glowAt(u, v);
		uu += background * background;
		uv += background * glow;
		vv += glow * glow;
		const at = pixels.indices[p]! * 3;
		for (let c = 0; c < 3; c++) {
			const y = pic.rgb[at + c]! - texel[c]!;
			uy[c]! += background * y;
			vy[c]! += glow * y;
			yy += y * y;
		}
	}
	const ridge = 1e-3 * (uu + 1);
	const det = (uu + ridge) * (vv + ridge) - uv * uv;
	let residual = yy;
	for (let c = 0; c < 3; c++) {
		const base = ((vv + ridge) * uy[c]! - uv * vy[c]!) / det;
		const glowColor = ((uu + ridge) * vy[c]! - uv * uy[c]!) / det;
		residual -= base * uy[c]! + glowColor * vy[c]!;
	}
	return residual / pixels.indices.length;
}
