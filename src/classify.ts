/**
 * Decides what each square holds: nothing, a void, or a piece. Candidates are ranked on sampled
 * patches, then the closest few are settled at pixel level, where look-alikes like the queen and
 * royal queen differ.
 */

import type { RGB } from './color.js';
import type { Square } from './grid.js';
import type { Fit, Matcher } from './matcher.js';
import type { Picture } from './picture.js';
import type { Piece } from './pieces.js';
import type { MipLevel } from './sprites.js';

import { colorDistance, luminance } from './color.js';
import { fitTemplate, glowAt, isPlain, meanColor, patchSums, rankFits } from './matcher.js';
import { royalCounterpart } from './pieces.js';
import { sampleTexture, textureLod } from './sprites.js';

// Types -----------------------------------------------------------------------

/** Everything classifying one screenshot's squares needs. */
export interface Reader {
	pic: Picture;
	matcher: Matcher;
	darkTile: RGB;
}

/** What one square holds. */
export type Verdict = { kind: 'empty' } | { kind: 'void' } | { kind: 'piece'; piece: Piece };

// Constants -------------------------------------------------------------------

/** A piece must leave at most this fraction of the residual of a bare background. */
const PIECE_FIT_RATIO = 0.8;

/** How many of a square's best-fitting pieces are compared again at pixel level. */
const FINALIST_COUNT = 3;

/** Sub-pixel offsets the finalists are fit at, in pixels along each axis. */
const ALIGNMENT_OFFSETS = [-0.3, -0.15, 0, 0.15, 0.3];

/** Pixel-level fits compare at most this many pixels per square side, skipping between them. */
const MAX_PIXELS_PER_SIDE = 24;

/** How much redder than green and blue a fitted glow is when a royal is in check. */
const CHECK_GLOW_REDNESS = 0.15;

// Functions -------------------------------------------------------------------

/** Decides what a square holds. */
export function classify(reader: Reader, square: Square, patch: Float32Array): Verdict {
	const { matcher, darkTile } = reader;
	const mean = meanColor(patch, matcher.mask);
	if (isPlain(patch, matcher.mask)) return backgroundVerdict(mean, darkTile);

	const sums = patchSums(matcher, patch);
	const ranked = rankFits(matcher, patch, sums);
	const background = fitTemplate(matcher.empty, matcher, patch, sums);
	if (ranked[0]!.residual > PIECE_FIT_RATIO * background.residual)
		return backgroundVerdict(mean, darkTile);
	const best = settle(reader, square, ranked.slice(0, FINALIST_COUNT));

	const piece = best.template.sprite!.piece;
	const royal = royalCounterpart(piece);
	const inCheck = best.glow[0] - (best.glow[1] + best.glow[2]) / 2 > CHECK_GLOW_REDNESS;
	return { kind: 'piece', piece: royal !== undefined && inCheck ? royal : piece };
}

/** A pieceless square is a void when it's clearly darker than even the dark tiles. */
function backgroundVerdict(mean: RGB, darkTile: RGB): Verdict {
	const isVoid =
		colorDistance(mean, darkTile) > 0.08 && luminance(mean) < 0.8 * luminance(darkTile);
	return isVoid ? { kind: 'void' } : { kind: 'empty' };
}

/**
 * Picks among a square's closest candidates by refitting each at pixel level, at the sub-pixel
 * alignment that suits it best. Returns the winner's fit to the patch.
 */
function settle(reader: Reader, square: Square, finalists: Fit[]): Fit {
	let best: Fit | undefined;
	let bestResidual = Infinity;
	for (const fit of finalists) {
		const levels = fit.template.sprite!.levels;
		for (const dy of ALIGNMENT_OFFSETS) {
			for (const dx of ALIGNMENT_OFFSETS) {
				const residual = fitPixels(reader.pic, square, levels, dx, dy);
				if (residual < bestResidual) {
					bestResidual = residual;
					best = fit;
				}
			}
		}
	}
	return best!;
}

/**
 * The mean residual of {@link fitTemplate}'s model at pixel level: the piece rendered at every
 * compared screen pixel's own position in the square, shifted by a sub-pixel offset, against the
 * raw pixels.
 */
function fitPixels(
	pic: Picture,
	square: Square,
	levels: MipLevel[],
	dx: number,
	dy: number,
): number {
	const { size } = square;
	const left = square.left + dx;
	const top = square.top + dy;
	const lod = textureLod(size);
	const margin = size / MAX_PIXELS_PER_SIDE + 0.5;
	// Compare the same pixels at every alignment; only the texture coordinates shift.
	const step = Math.max(1, Math.floor(size / MAX_PIXELS_PER_SIDE));
	const texel = new Float32Array(4);
	let uu = 0;
	let uv = 0;
	let vv = 0;
	let yy = 0;
	let n = 0;
	const uy: RGB = [0, 0, 0];
	const vy: RGB = [0, 0, 0];
	for (
		let py = Math.ceil(square.top + margin - 0.5);
		py + 0.5 <= square.top + size - margin;
		py += step
	) {
		for (
			let px = Math.ceil(square.left + margin - 0.5);
			px + 0.5 <= square.left + size - margin;
			px += step
		) {
			if (px < 0 || py < 0 || px >= pic.width || py >= pic.height) continue;
			const u = (px + 0.5 - left) / size;
			const v = (py + 0.5 - top) / size;
			sampleTexture(levels, lod, u, v, texel);
			const background = 1 - texel[3]!;
			const glow = background * glowAt(u, v);
			uu += background * background;
			uv += background * glow;
			vv += glow * glow;
			for (let c = 0; c < 3; c++) {
				const y = pic.rgb[(py * pic.width + px) * 3 + c]! - texel[c]!;
				uy[c]! += background * y;
				vy[c]! += glow * y;
				yy += y * y;
			}
			n++;
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
	return residual / n;
}
