/**
 * Fits rendered piece templates to sampled squares. Each fit solves, in closed form, for the
 * background a template sits on: a base color plus the radial red glow of a royal in check, so
 * highlights and checks never throw a match off.
 */

import type { RGB } from './color.js';
import type { Homography } from './homography.js';
import type { Picture } from './picture.js';
import type { Square } from './view.js';
import type { Sprite } from './sprites.js';

import { samplePatch } from './picture.js';
import { renderSprite } from './sprites.js';

// Types -----------------------------------------------------------------------

/** A piece rendered at the comparison resolution, with its background-fit terms. */
export interface Template {
	/** Absent on the empty template, which fits a square as background alone. */
	sprite?: Sprite;
	/** The sprite's place in the sprite list. */
	index: number;
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
	/** Alpha terms used by the local brightness response of photographed displays. */
	aa: number;
	ua: number;
	va: number;
	aP: RGB;
}

/** Squares near enough in size on screen to share templates, rendered at their mean size. */
export interface SizeClass {
	size: number;
	/** Samples per square side. */
	samples: number;
}

/** A square as sampled, and the size class it's compared at. */
export interface SampledSquare {
	square: Square;
	sizeClass: SizeClass;
	/** The mean color within its margin. */
	mean: RGB;
	/** Its patch, absent when a coarse look already shows it plain, holding no piece. */
	patch?: Float32Array;
}

/** A sampled square showing something on it, as a piece would. */
export interface BusySquare extends SampledSquare {
	patch: Float32Array;
}

/** Everything square fitting needs at one comparison resolution and blur. */
export interface Matcher {
	/** Samples per square side. */
	samples: number;
	/** Which samples are compared: all but the outer ring, which neighboring squares bleed into. */
	mask: Uint8Array;
	/** The check glow's opacity over a square. */
	glow: Float32Array;
	/** How many sprites have templates. */
	count: number;
	/** A sprite's template, built when first asked for. */
	template: (index: number) => Template;
	/** The fully transparent template. */
	empty: Template;
	/** The same templates at fewer samples, to shortlist candidates on. Absent when there are few already. */
	coarse?: Matcher;
	/** Photographs fit a bounded local brightness response as lighting varies across the display. */
	photographed?: true;
}

/** A photographed square's affine brightness response, shared across its RGB channels. */
export interface CameraResponse {
	gain: number;
	offset: RGB;
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
	/** The local camera response fitted to this candidate. */
	response?: CameraResponse;
	/** Photographic noise measured where this sprite leaves the tile bare, per sample. */
	noise?: number;
}

// Constants -------------------------------------------------------------------

/** Mean sample deviation from the square's mean color below which it holds no piece. */
const PLAIN_THRESHOLD = 0.02;

/** The samples per side of a square's first, coarse look. */
const GLANCE_SAMPLES = 4;

/** The same, for that coarse look, whose larger samples average away more noise. */
const GLANCE_PLAIN_THRESHOLD = 0.01;

/** Every sample of a coarse look, which already leaves out the square's margin. */
const GLANCE_MASK = new Uint8Array(GLANCE_SAMPLES * GLANCE_SAMPLES).fill(1);

/** Blurs tried on the sprites to match a resampled screenshot's, as Gaussian sigmas in samples. */
const BLUR_SIGMAS = [0, 0.25, 0.4, 0.55, 0.7, 0.85, 1, 1.2];

/** How many busy squares the blur is chosen on. */
const BLUR_PROBE_COUNT = 48;

/** The blur the busy squares' likeliest pieces are first shortlisted at. */
const MIDDLE_SIGMA = 0.55;

/** How many likeliest pieces of each busy square the other blurs are tried on. */
const BLUR_CANDIDATES = 4;

/** The samples per side of the coarse templates candidates are shortlisted on. */
const COARSE_SAMPLES = 8;

/** How many candidates the coarse templates shortlist for a full fit. */
const SHORTLIST = 6;

/** How many size classes divide each doubling of square size. */
const SIZE_CLASSES_PER_OCTAVE = 8;

/** Bounds of the samples per square side. Larger squares are averaged down to the max. */
const MIN_SAMPLES = 8;
const MAX_SAMPLES = 24;

/** Radii of the check glow, in squares: solid inside the inner, fading out by the outer. */
const GLOW_INNER_RADIUS = 0.3;
const GLOW_OUTER_RADIUS = 0.65;

// State -----------------------------------------------------------------------

/** The masks of {@link innerMask}, by sample count. */
const MASKS = new Map<number, Uint8Array>();

/** Small photographic alignment corrections, shared by repeated fits of the same template. */
const ALIGNED = new WeakMap<Template, Template[]>();

// Building --------------------------------------------------------------------

/**
 * Samples squares, each at the resolution of its size class. Most squares hold no piece, so each
 * is first looked at coarsely, and only sampled in full when that shows anything on it.
 */
export function sampleSquares(
	pic: Picture,
	toImage: Homography,
	squares: Square[],
): SampledSquare[] {
	const sizeClasses = sizeClassesOf(squares);
	return squares.map((square) => {
		const sizeClass = sizeClasses.get(square)!;
		const margin = 1 / sizeClass.samples;
		const corner: [number, number] = [square.column + margin, square.row + margin];
		const glance = samplePatch(pic, toImage, corner, 1 - 2 * margin, GLANCE_SAMPLES);
		if (deviation(glance, GLANCE_MASK) < GLANCE_PLAIN_THRESHOLD) {
			return { square, sizeClass, mean: meanColor(glance, GLANCE_MASK) };
		}
		const patch = samplePatch(pic, toImage, [square.column, square.row], 1, sizeClass.samples);
		return { square, sizeClass, mean: meanColor(patch, innerMask(sizeClass.samples)), patch };
	});
}

/** Whether a sampled square shows something on it, as a piece would. */
export function isBusy(sampled: SampledSquare): sampled is BusySquare {
	return sampled.patch !== undefined && !isPlain(sampled.patch, innerMask(sampled.sizeClass.samples)); // prettier-ignore
}

/** Groups squares into size classes, each rendered at the mean size of its squares. */
export function sizeClassesOf(squares: Square[]): Map<Square, SizeClass> {
	const groups = new Map<number, Square[]>();
	for (const square of squares) {
		const key = Math.round(Math.log2(square.size) * SIZE_CLASSES_PER_OCTAVE);
		const group = groups.get(key);
		if (group) group.push(square);
		else groups.set(key, [square]);
	}
	const classes = new Map<Square, SizeClass>();
	for (const members of groups.values()) {
		const size = members.reduce((sum, square) => sum + square.size, 0) / members.length;
		const sizeClass = { size, samples: Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.round(size))) }; // prettier-ignore
		for (const square of members) classes.set(square, sizeClass);
	}
	return classes;
}

/**
 * Picks the blur that best explains a spread of the busy squares, and returns each size class's
 * templates at it, built when first asked for. One blur fits the whole screenshot, as it comes
 * from how the screenshot was resampled.
 */
export function chooseMatchers(
	sprites: Sprite[],
	sampled: SampledSquare[],
	photographed = false,
): (sizeClass: SizeClass) => Matcher {
	const busy = sampled.filter((square) => isBusy(square));
	const render = renderer(sprites);
	const asPhotographed = (matcher: Matcher): Matcher => {
		if (photographed) {
			matcher.photographed = true;
			if (matcher.coarse) asPhotographed(matcher.coarse);
		}
		return matcher;
	};
	const build = (sizeClass: SizeClass, sigma: number): Matcher =>
		asPhotographed(buildMatcher(sprites, render, sizeClass, sigma));

	const middle = new Map<SizeClass, Matcher>();
	const middleAt = (sizeClass: SizeClass): Matcher => {
		if (!middle.has(sizeClass)) middle.set(sizeClass, build(sizeClass, MIDDLE_SIGMA));
		return middle.get(sizeClass)!;
	};
	// Camera noise can make every bare tile busy. Estimate blur and brightness from pieces alone.
	const candidates = photographed
		? busy.filter(({ sizeClass, patch }) => {
				const matcher = middleAt(sizeClass);
				const sums = patchSums(matcher, patch);
				return rankFits(matcher, patch, sums)[0]!.residual < 0.8 * fitTemplate(matcher.empty, matcher, patch, sums).residual; // prettier-ignore
			})
		: busy;
	const stride = Math.max(1, Math.floor(candidates.length / BLUR_PROBE_COUNT));
	const probes = candidates.filter((_, index) => index % stride === 0);

	// Each probe's likeliest pieces are shortlisted once, at a middle blur. Other blurs fit only those.
	const shortlists = probes.map(({ sizeClass, patch }) => {
		const matcher = middleAt(sizeClass);
		const fits = rankFits(matcher, patch, patchSums(matcher, patch)).slice(0, BLUR_CANDIDATES);
		return fits.map((fit) => fit.template.index);
	});
	const score = (sigma: number): number => {
		const built = new Map<string, Template>();
		let total = 0;
		probes.forEach(({ sizeClass, patch }, p) => {
			const matcher = middle.get(sizeClass)!;
			const sums = patchSums(matcher, patch);
			total += Math.min(
				...shortlists[p]!.map((index) => {
					const key = `${sizeClass.size},${index}`;
					if (!built.has(key)) built.set(key, buildTemplate(sprites[index], index, blur(render(sizeClass.size, sizeClass.samples, index), sizeClass.samples, sigma), matcher.mask, matcher.glow)); // prettier-ignore
					return fitTemplate(built.get(key)!, matcher, patch, sums).residual;
				}),
			);
		});
		return total;
	};
	// The fit worsens steadily away from the best blur, so walking downhill from the middle finds it.
	const scores = new Map<number, number>();
	const scoreAt = (index: number): number => {
		if (index < 0 || index >= BLUR_SIGMAS.length) return Infinity;
		if (!scores.has(index)) scores.set(index, score(BLUR_SIGMAS[index]!));
		return scores.get(index)!;
	};
	let at = BLUR_SIGMAS.indexOf(MIDDLE_SIGMA);
	for (;;) {
		const step = scoreAt(at - 1) < scoreAt(at) ? -1 : scoreAt(at + 1) < scoreAt(at) ? 1 : 0;
		if (step === 0) break;
		at += step;
	}
	const sigma = BLUR_SIGMAS[at]!;
	const chosen = sigma === MIDDLE_SIGMA ? middle : new Map<SizeClass, Matcher>();
	const matcherAt = (sizeClass: SizeClass): Matcher => {
		if (!chosen.has(sizeClass)) chosen.set(sizeClass, build(sizeClass, sigma));
		return chosen.get(sizeClass)!;
	};
	return (sizeClass) => asPhotographed(matcherAt(sizeClass));
}

/** Renders sprites at a square size and resolution, each kept once rendered. */
function renderer(
	sprites: Sprite[],
): (size: number, samples: number, index: number) => Float32Array {
	const renders = new Map<string, Float32Array>();
	return (size, samples, index) => {
		const key = `${size},${samples},${index}`;
		if (!renders.has(key))
			renders.set(key, renderSprite(sprites[index]!.levels, size, samples));
		return renders.get(key)!;
	};
}

/**
 * The templates of a size class at a blur, each built when first asked for, and coarse versions to
 * shortlist on if there are samples to spare.
 */
function buildMatcher(
	sprites: Sprite[],
	render: (size: number, samples: number, index: number) => Float32Array,
	{ size, samples }: SizeClass,
	sigma: number,
): Matcher {
	const coarse =
		samples >= 1.5 * COARSE_SAMPLES
			? matcherOf(sprites, COARSE_SAMPLES, (index) => blur(render((size * COARSE_SAMPLES) / samples, COARSE_SAMPLES, index), COARSE_SAMPLES, (sigma * COARSE_SAMPLES) / samples)) // prettier-ignore
			: undefined;
	return matcherOf(sprites, samples, (index) => blur(render(size, samples, index), samples, sigma), coarse); // prettier-ignore
}

/** A matcher whose templates are built from their renders when first asked for. */
function matcherOf(
	sprites: Sprite[],
	samples: number,
	rendered: (index: number) => Float32Array,
	coarse?: Matcher,
): Matcher {
	const mask = innerMask(samples);
	const glow = glowProfile(samples);
	const built: Template[] = [];
	const template = (index: number): Template =>
		(built[index] ??= buildTemplate(sprites[index], index, rendered(index), mask, glow));
	const empty = buildTemplate(undefined, -1, new Float32Array(samples * samples * 4), mask, glow);
	return { samples, mask, glow, count: sprites.length, template, empty, coarse };
}

/** Box-averages a square grid of values, area-weighted, down to fewer cells per side. */
function resample(values: Float32Array, from: number, to: number, channels: number): Float32Array {
	const out = new Float32Array(to * to * channels);
	const scale = from / to;
	for (let oy = 0; oy < to; oy++) {
		const [y0, y1] = [oy * scale, (oy + 1) * scale];
		for (let ox = 0; ox < to; ox++) {
			const [x0, x1] = [ox * scale, (ox + 1) * scale];
			const at = (oy * to + ox) * channels;
			for (let iy = Math.floor(y0); iy < Math.ceil(y1); iy++) {
				const wy = Math.min(y1, iy + 1) - Math.max(y0, iy);
				for (let ix = Math.floor(x0); ix < Math.ceil(x1); ix++) {
					const weight =
						(wy * (Math.min(x1, ix + 1) - Math.max(x0, ix))) / (scale * scale);
					for (let c = 0; c < channels; c++) out[at + c]! += weight * values[(iy * from + ix) * channels + c]!; // prettier-ignore
				}
			}
		}
	}
	return out;
}

/** Every sample of a square but its outer ring, kept per sample count. */
export function innerMask(samples: number): Uint8Array {
	const kept = MASKS.get(samples);
	if (kept) return kept;
	const mask = new Uint8Array(samples * samples);
	MASKS.set(samples, mask);
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
		(GLOW_OUTER_RADIUS - Math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2)) /
		(GLOW_OUTER_RADIUS - GLOW_INNER_RADIUS);
	return Math.min(1, Math.max(0, fade));
}

/** Gaussian-blurs a samples x samples RGBA image, treating everything beyond it as transparent. */
function blur(rgba: Float32Array, samples: number, sigma: number): Float32Array {
	if (sigma === 0) return rgba;
	const radius = Math.ceil(3 * sigma);
	const kernel = new Float64Array(2 * radius + 1);
	for (let k = -radius; k <= radius; k++) kernel[k + radius] = Math.exp(-(k * k) / (2 * sigma * sigma)); // prettier-ignore
	const kernelSum = kernel.reduce((a, b) => a + b, 0);
	for (let k = 0; k < kernel.length; k++) kernel[k]! /= kernelSum;

	// One pass along rows (stride 1) or columns (stride samples), skipping taps beyond the edge.
	const pass = (src: Float32Array, stride: number): Float32Array => {
		const dst = new Float32Array(src.length);
		for (let y = 0; y < samples; y++) {
			for (let x = 0; x < samples; x++) {
				const along = stride === 1 ? x : y;
				const at = (y * samples + x) * 4;
				for (
					let k = Math.max(-radius, -along);
					k <= Math.min(radius, samples - 1 - along);
					k++
				) {
					const w = kernel[k + radius]!;
					const from = at + k * stride * 4;
					dst[at]! += w * src[from]!;
					dst[at + 1]! += w * src[from + 1]!;
					dst[at + 2]! += w * src[from + 2]!;
					dst[at + 3]! += w * src[from + 3]!;
				}
			}
		}
		return dst;
	};
	return pass(pass(rgba, 1), samples);
}

/** Splits a rendered sprite into a template and precomputes its background-fit terms. */
function buildTemplate(
	sprite: Sprite | undefined,
	index: number,
	rgba: Float32Array,
	mask: Uint8Array,
	glow: Float32Array,
): Template {
	const n = mask.length;
	const color = new Float32Array(n * 3);
	const alpha = new Float32Array(n);
	const t: Template = {
		sprite,
		index,
		color,
		alpha,
		uu: 0,
		uv: 0,
		vv: 0,
		uP: [0, 0, 0],
		vP: [0, 0, 0],
		PP: 0,
		aa: 0,
		ua: 0,
		va: 0,
		aP: [0, 0, 0],
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
		t.aa += alpha[p]! * alpha[p]!;
		t.ua += u * alpha[p]!;
		t.va += v * alpha[p]!;
		for (let c = 0; c < 3; c++) {
			const P = color[p * 3 + c]!;
			t.uP[c]! += u * P;
			t.vP[c]! += v * P;
			t.PP += P * P;
			t.aP[c]! += alpha[p]! * P;
		}
	}
	return t;
}

// Patches ---------------------------------------------------------------------

/** Whether a patch's masked samples are all close to their mean, so it holds no piece. */
export function isPlain(patch: Float32Array, mask: Uint8Array): boolean {
	return deviation(patch, mask) < PLAIN_THRESHOLD;
}

/** The mean distance of a patch's masked samples from their mean color. */
function deviation(patch: Float32Array, mask: Uint8Array): number {
	const mean = meanColor(patch, mask);
	let total = 0;
	let n = 0;
	for (let p = 0; p < mask.length; p++) {
		if (!mask[p]) continue;
		const r = patch[p * 3]! - mean[0];
		const g = patch[p * 3 + 1]! - mean[1];
		const b = patch[p * 3 + 2]! - mean[2];
		total += Math.sqrt(r * r + g * g + b * b);
		n++;
	}
	return total / n;
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

/** The fits of a patch's likeliest templates, best first, shortlisted on the coarse templates if any. */
export function rankFits(matcher: Matcher, patch: Float32Array, sums: PatchSums): Fit[] {
	let candidates = Array.from({ length: matcher.count }, (_, index) => index);
	const { coarse } = matcher;
	if (coarse) {
		const small = resample(patch, matcher.samples, coarse.samples, 3);
		const shortlist = rankFits(coarse, small, patchSums(coarse, small)).slice(0, matcher.photographed ? 2 * SHORTLIST : SHORTLIST); // prettier-ignore
		candidates = shortlist.map((fit) => fit.template.index);
	}
	const fits = candidates.map((index) => fitTemplate(matcher.template(index), matcher, patch, sums)); // prettier-ignore
	return fits.sort((a, b) => a.residual - b.residual);
}

/** Settles noisy photographic candidates on averaged patches, allowing slight corner-fit errors. */
export function refinePhotoFits(
	matcher: Matcher,
	patch: Float32Array,
	sums: PatchSums,
	ranked: Fit[],
): Fit[] {
	return ranked
		.slice(0, 2 * SHORTLIST)
		.map((fit) => {
			const { template } = fit;
			let shifted = ALIGNED.get(template);
			if (!shifted) {
				shifted = [];
				const n = matcher.samples;
				for (const dy of [-1, -0.5, 0, 0.5, 1]) {
					for (const dx of [-1, -0.5, 0, 0.5, 1]) {
						if (dx === 0 && dy === 0) continue;
						const rgba = new Float32Array(n * n * 4);
						for (let y = 0; y < n; y++) {
							for (let x = 0; x < n; x++) {
								const sx = x - dx;
								const sy = y - dy;
								const at = (y * n + x) * 4;
								const ix = Math.floor(sx);
								const iy = Math.floor(sy);
								for (let oy = 0; oy < 2; oy++) {
									for (let ox = 0; ox < 2; ox++) {
										if (
											ix + ox < 0 ||
											iy + oy < 0 ||
											ix + ox >= n ||
											iy + oy >= n
										)
											continue;
										const source = (iy + oy) * n + ix + ox;
										const weight =
											(ox ? sx - ix : 1 - sx + ix) *
											(oy ? sy - iy : 1 - sy + iy);
										rgba[at + 3]! += weight * template.alpha[source]!;
										for (let c = 0; c < 3; c++)
											rgba[at + c]! +=
												weight * template.color[source * 3 + c]!;
									}
								}
							}
						}
						shifted.push(buildTemplate(template.sprite, template.index, rgba, matcher.mask, matcher.glow)); // prettier-ignore
					}
				}
				ALIGNED.set(template, shifted);
			}
			for (const aligned of shifted) {
				const candidate = fitTemplate(aligned, matcher, patch, sums);
				// Prefer the measured grid alignment unless moving the piece materially improves its fit.
				candidate.residual += 0.002 * matcher.mask.reduce((sum, kept) => sum + kept, 0);
				if (candidate.residual < fit.residual) fit = candidate;
			}
			return fit;
		})
		.sort((a, b) => a.residual - b.residual);
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
	if (matcher.photographed && template.sprite) {
		return fitPhotographed(template, matcher, patch, sums, aO, agO, OP, m00, m11, det);
	}
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

/**
 * A photographed display's local affine response has one brightness gain and one gray black-level
 * offset. Both are shared by its RGB channels, preserving a colored player's hue. The square's
 * background and check glow are still independent RGB colors.
 */
function fitPhotographed(
	template: Template,
	matcher: Matcher,
	patch: Float32Array,
	sums: PatchSums,
	aO: RGB,
	agO: RGB,
	OP: number,
	m00: number,
	m11: number,
	det: number,
): Fit {
	const projectOut = (u: number, v: number, x: number, y: number): number =>
		(m11 * u * x - template.uv * (u * y + v * x) + m00 * v * y) / det;
	const ap = template.aP.reduce((a, b) => a + b, 0);
	const ao = aO.reduce((a, b) => a + b, 0);
	let pp = template.PP;
	let pa = ap;
	let po = OP;
	let ay = ao;
	const aa = 3 * (template.aa - projectOut(template.ua, template.va, template.ua, template.va));
	for (let c = 0; c < 3; c++) {
		const u = template.uP[c]!;
		const v = template.vP[c]!;
		const x = sums.sum[c]! - aO[c]!;
		const y = sums.glowSum[c]! - agO[c]!;
		pp -= projectOut(u, v, u, v);
		pa -= projectOut(u, v, template.ua, template.va);
		po -= projectOut(u, v, x, y);
		ay -= projectOut(template.ua, template.va, x, y);
	}
	const ridge = 0.002 * (template.aa + 1);
	const d = (pp + ridge) * (aa + ridge) - pa * pa;
	let gain = ((aa + ridge) * (po + ridge) - pa * ay) / d;
	let offset = ((pp + ridge) * ay - pa * (po + ridge)) / d;
	// When a response reaches a physical bound, refit the other coefficient at that bound.
	for (let step = 0; step < 4; step++) {
		gain = Math.max(0.2, Math.min(1.3, gain));
		offset = Math.max(-0.05, Math.min(0.4, (ay - pa * gain) / (aa + ridge)));
		gain = Math.max(0.2, Math.min(1.3, (po + ridge - pa * offset) / (pp + ridge)));
	}
	let residual = sums.energy - 2 * gain * OP - 2 * offset * ao + gain * gain * template.PP + 2 * gain * offset * ap + 3 * offset * offset * template.aa; // prettier-ignore
	const glow: RGB = [0, 0, 0];
	const background: RGB = [0, 0, 0];
	for (let c = 0; c < 3; c++) {
		const u = sums.sum[c]! - aO[c]! - gain * template.uP[c]! - offset * template.ua;
		const v = sums.glowSum[c]! - agO[c]! - gain * template.vP[c]! - offset * template.va;
		const base = (m11 * u - template.uv * v) / det;
		background[c] = base;
		glow[c] = (m00 * v - template.uv * u) / det;
		residual -= base * u + glow[c]! * v;
	}
	// A weak camera prior breaks noisy ties without letting an almost gray, saturated piece
	// impersonate another player's sprite through an extreme response at both bounds.
	residual += 0.02 * template.aa * ((gain - 0.8) ** 2 + (offset - 0.08) ** 2);
	const response = { gain, offset: [offset, offset, offset] as RGB };
	let noise = 0;
	let bare = 0;
	for (let p = 0; p < matcher.mask.length; p++) {
		if (!matcher.mask[p] || template.alpha[p]! > 0.05) continue;
		for (let c = 0; c < 3; c++) {
			const predicted = gain * template.color[p * 3 + c]! + offset * template.alpha[p]! + (1 - template.alpha[p]!) * (background[c]! + glow[c]! * matcher.glow[p]!); // prettier-ignore
			noise += (patch[p * 3 + c]! - predicted) ** 2;
		}
		bare++;
	}
	return {
		template,
		residual: Math.max(residual, 0),
		glow,
		response,
		noise: bare ? noise / bare : 0,
	};
}
