/**
 * Fits rendered piece templates to sampled squares. Each fit solves, in closed form, for the
 * background a template sits on: a base color plus the radial red glow of a royal in check, so
 * highlights and checks never throw a match off.
 */

import type { RGB } from './color.js';
import type { Sprite } from './sprites.js';

import { renderSprite } from './sprites.js';

// Types -----------------------------------------------------------------------

/** A piece rendered at the comparison resolution, with its background-fit terms. */
export interface Template {
	/** Absent on the empty template, which fits a square as background alone. */
	sprite?: Sprite;
	/** Premultiplied color, samples^2 x 3. */
	color: Float32Array;
	alpha: Float32Array;
	/** Gram matrix of the background basis u = 1-alpha, v = u*glow, over the mask. */
	uu: number;
	uv: number;
	vv: number;
	/** Per channel: each basis dotted with the sprite color. */
	uP: RGB;
	vP: RGB;
	/** Energy of the sprite color, all channels. */
	PP: number;
}

/** Everything square fitting needs at one comparison resolution and blur. */
export interface Matcher {
	/** Samples per square side. */
	samples: number;
	/** Which samples are compared: all but the outer ring, which neighboring squares bleed into. */
	mask: Uint8Array;
	/** The check glow's opacity over a square. */
	glow: Float32Array;
	templates: Template[];
	/** The fully transparent template. */
	empty: Template;
}

/** Patch-only sums shared by every template fit of one square. */
export interface PatchSums {
	/** Per channel: sum of the patch, and of the patch times the glow. */
	sum: RGB;
	glowSum: RGB;
	energy: number;
}

/** How well a template explains a square. */
export interface Fit {
	template: Template;
	residual: number;
	/** Fitted glow color, as an offset from the base background. */
	glow: RGB;
}

// Constants -------------------------------------------------------------------

/** Mean sample deviation from the square's mean color below which it holds no piece. */
const PLAIN_THRESHOLD = 0.02;

/** Blurs tried on the sprites to match a resampled screenshot's, as Gaussian sigmas in samples. */
const BLUR_SIGMAS = [0, 0.25, 0.4, 0.55, 0.7, 0.85, 1, 1.2];

/** How many busy squares the blur is chosen on. */
const BLUR_PROBE_COUNT = 48;

/** Radii of the check glow, in squares: solid inside the inner, fading out by the outer. */
const GLOW_INNER_RADIUS = 0.3;
const GLOW_OUTER_RADIUS = 0.65;

// Building --------------------------------------------------------------------

/** Picks the blur whose templates best explain a spread of the busy squares. */
export function chooseMatcher(
	sprites: Sprite[],
	squareSize: number,
	samples: number,
	patches: Float32Array[],
): Matcher {
	const mask = innerMask(samples);
	const busy = patches.filter((patch) => !isPlain(patch, mask));
	const stride = Math.max(1, Math.floor(busy.length / BLUR_PROBE_COUNT));
	const probes = busy.filter((_, index) => index % stride === 0);

	const renders = sprites.map((sprite) => renderSprite(sprite.levels, squareSize, samples));
	let best: Matcher | undefined;
	let bestScore = Infinity;
	for (const sigma of BLUR_SIGMAS) {
		const matcher = buildMatcher(sprites, renders, samples, sigma);
		let score = 0;
		for (const patch of probes)
			score += rankFits(matcher, patch, patchSums(matcher, patch))[0]!.residual;
		if (score < bestScore) {
			bestScore = score;
			best = matcher;
		}
	}
	return best!;
}

/** Builds every piece's template from its render, at a blur. */
function buildMatcher(
	sprites: Sprite[],
	renders: Float32Array[],
	samples: number,
	sigma: number,
): Matcher {
	const mask = innerMask(samples);
	const glow = glowProfile(samples);
	const templates = sprites.map((sprite, index) =>
		buildTemplate(sprite, blur(renders[index]!, samples, sigma), mask, glow),
	);
	const empty = buildTemplate(undefined, new Float32Array(samples * samples * 4), mask, glow);
	return { samples, mask, glow, templates, empty };
}

/** Every sample of a square but its outer ring. */
export function innerMask(samples: number): Uint8Array {
	const mask = new Uint8Array(samples * samples);
	for (let y = 1; y < samples - 1; y++)
		for (let x = 1; x < samples - 1; x++) mask[y * samples + x] = 1;
	return mask;
}

/** The check glow's opacity over a square, 1 at its solid center. */
function glowProfile(samples: number): Float32Array {
	const glow = new Float32Array(samples * samples);
	for (let y = 0; y < samples; y++) {
		for (let x = 0; x < samples; x++) {
			glow[y * samples + x] = glowAt((x + 0.5) / samples, (y + 0.5) / samples);
		}
	}
	return glow;
}

/** The check glow's opacity at a point of a square, in square units. */
export function glowAt(u: number, v: number): number {
	const fade =
		(GLOW_OUTER_RADIUS - Math.hypot(u - 0.5, v - 0.5)) /
		(GLOW_OUTER_RADIUS - GLOW_INNER_RADIUS);
	return Math.min(1, Math.max(0, fade));
}

/** Gaussian-blurs a samples x samples RGBA image, treating everything beyond it as transparent. */
function blur(rgba: Float32Array, samples: number, sigma: number): Float32Array {
	if (sigma === 0) return rgba;
	const radius = Math.ceil(3 * sigma);
	const kernel: number[] = [];
	for (let k = -radius; k <= radius; k++) kernel.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
	const kernelSum = kernel.reduce((a, b) => a + b, 0);

	const pass = (src: Float32Array, dx: number, dy: number): Float32Array => {
		const dst = new Float32Array(src.length);
		for (let y = 0; y < samples; y++) {
			for (let x = 0; x < samples; x++) {
				for (let k = -radius; k <= radius; k++) {
					const sx = x + k * dx;
					const sy = y + k * dy;
					if (sx < 0 || sy < 0 || sx >= samples || sy >= samples) continue;
					const w = kernel[k + radius]! / kernelSum;
					for (let c = 0; c < 4; c++)
						dst[(y * samples + x) * 4 + c]! += w * src[(sy * samples + sx) * 4 + c]!;
				}
			}
		}
		return dst;
	};
	return pass(pass(rgba, 1, 0), 0, 1);
}

/** Splits a rendered sprite into a template and precomputes its background-fit terms. */
function buildTemplate(
	sprite: Sprite | undefined,
	rgba: Float32Array,
	mask: Uint8Array,
	glow: Float32Array,
): Template {
	const n = mask.length;
	const color = new Float32Array(n * 3);
	const alpha = new Float32Array(n);
	const t: Template = {
		sprite,
		color,
		alpha,
		uu: 0,
		uv: 0,
		vv: 0,
		uP: [0, 0, 0],
		vP: [0, 0, 0],
		PP: 0,
	};
	for (let p = 0; p < n; p++) {
		alpha[p] = rgba[p * 4 + 3]!;
		for (let c = 0; c < 3; c++) color[p * 3 + c] = rgba[p * 4 + c]!;
		if (!mask[p]) continue;
		const u = 1 - alpha[p]!;
		const v = u * glow[p]!;
		t.uu += u * u;
		t.uv += u * v;
		t.vv += v * v;
		for (let c = 0; c < 3; c++) {
			const P = color[p * 3 + c]!;
			t.uP[c]! += u * P;
			t.vP[c]! += v * P;
			t.PP += P * P;
		}
	}
	return t;
}

// Patches ---------------------------------------------------------------------

/** Whether a patch's masked samples are all close to their mean, so it holds no piece. */
export function isPlain(patch: Float32Array, mask: Uint8Array): boolean {
	const mean = meanColor(patch, mask);
	let deviation = 0;
	let n = 0;
	for (let p = 0; p < mask.length; p++) {
		if (!mask[p]) continue;
		deviation += Math.hypot(
			patch[p * 3]! - mean[0],
			patch[p * 3 + 1]! - mean[1],
			patch[p * 3 + 2]! - mean[2],
		);
		n++;
	}
	return deviation / n < PLAIN_THRESHOLD;
}

/** The mean color of a patch's masked samples. */
export function meanColor(patch: Float32Array, mask: Uint8Array): RGB {
	const mean: RGB = [0, 0, 0];
	let n = 0;
	for (let p = 0; p < mask.length; p++) {
		if (!mask[p]) continue;
		for (let c = 0; c < 3; c++) mean[c]! += patch[p * 3 + c]!;
		n++;
	}
	return [mean[0] / n, mean[1] / n, mean[2] / n];
}

/** Computes the patch-only sums of the template fits. */
export function patchSums(matcher: Matcher, patch: Float32Array): PatchSums {
	const sums: PatchSums = { sum: [0, 0, 0], glowSum: [0, 0, 0], energy: 0 };
	for (let p = 0; p < matcher.mask.length; p++) {
		if (!matcher.mask[p]) continue;
		for (let c = 0; c < 3; c++) {
			const O = patch[p * 3 + c]!;
			sums.sum[c]! += O;
			sums.glowSum[c]! += O * matcher.glow[p]!;
			sums.energy += O * O;
		}
	}
	return sums;
}

// Fitting ---------------------------------------------------------------------

/** Every template's fit to a patch, best first. */
export function rankFits(matcher: Matcher, patch: Float32Array, sums: PatchSums): Fit[] {
	const fits = matcher.templates.map((template) => fitTemplate(template, matcher, patch, sums));
	return fits.sort((a, b) => a.residual - b.residual);
}

/**
 * Least-squares fits patch = sprite + (1-alpha) * (base + glow * glowColor), solving the base and
 * glow colors per channel in closed form from the precomputed sums.
 */
export function fitTemplate(
	template: Template,
	matcher: Matcher,
	patch: Float32Array,
	sums: PatchSums,
): Fit {
	const { mask, glow } = matcher;
	const { alpha, color } = template;
	// The patch dotted with alpha and alpha*glow per channel, and with the sprite color.
	const aO: RGB = [0, 0, 0];
	const agO: RGB = [0, 0, 0];
	let OP = 0;
	for (let p = 0; p < mask.length; p++) {
		const a = alpha[p]!;
		if (!mask[p] || a === 0) continue;
		const ag = a * glow[p]!;
		for (let c = 0; c < 3; c++) {
			const O = patch[p * 3 + c]!;
			aO[c]! += a * O;
			agO[c]! += ag * O;
			OP += O * color[p * 3 + c]!;
		}
	}
	// Ridge-regularized, as a sprite covering the glow's center leaves its color undetermined.
	const ridge = 1e-3 * (template.uu + 1);
	const m00 = template.uu + ridge;
	const m11 = template.vv + ridge;
	const det = m00 * m11 - template.uv * template.uv;
	let residual = sums.energy - 2 * OP + template.PP;
	const glowColor: RGB = [0, 0, 0];
	for (let c = 0; c < 3; c++) {
		const uy = sums.sum[c]! - aO[c]! - template.uP[c]!;
		const vy = sums.glowSum[c]! - agO[c]! - template.vP[c]!;
		const base = (m11 * uy - template.uv * vy) / det;
		glowColor[c] = (m00 * vy - template.uv * uy) / det;
		residual -= base * uy + glowColor[c]! * vy;
	}
	return { template, residual: Math.max(residual, 0), glow: glowColor };
}
