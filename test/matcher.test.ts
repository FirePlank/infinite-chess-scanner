import assert from 'node:assert/strict';
import test from 'node:test';

import type { RGB } from '../src/color.js';
import type { SampledSquare } from '../src/matcher.js';
import type { Reader } from '../src/classify.js';
import { classify } from '../src/classify.js';
import {
	chooseMatchers,
	glowAt,
	isPhotographicBackground,
	patchSums,
	photoBackground,
	rankFits,
	refinePhotoFits,
} from '../src/matcher.js';
import { abbreviate } from '../src/pieces.js';
import { loadSprites, renderSprite } from '../src/sprites.js';

test("preserves every player's pieces under photographic glare and color casts", async () => {
	const sprites = await loadSprites();
	const sizeClass = { size: 64, samples: 24 };
	const specimens: (SampledSquare & { patch: Float32Array; expected: string })[] = [];
	for (const response of [
		{ gain: 0.65, offset: [0.15, 0.23, 0.26], background: [0.68, 0.53, 0.35] },
		{ gain: 0.35, offset: [0.28, 0.33, 0.36], background: [0.68, 0.53, 0.35] },
		{ gain: 0.8, offset: [0.05, 0.06, 0.08], background: [0.68, 0.53, 0.35] },
		{ gain: 0.7, offset: [0.12, 0.12, 0.12], background: [0.45, 0.5, 0.5] },
		{ gain: 0.55, offset: [0.04, 0.19, 0.2], background: [0.16, 0.84, 0.85] },
	]) {
		const background = response.background as RGB;
		for (const player of [1, 2, 3, 4, 5, 6]) {
			for (const kind of ['p', 'r', 'n', 'b', 'k', 'q', 'gu']) {
				const sprite = sprites.find(
					(candidate) =>
						candidate.piece.player === player && candidate.piece.kind.code === kind,
				)!;
				const rgba = renderSprite(sprite.levels, sizeClass.size, sizeClass.samples);
				const patch = new Float32Array(sizeClass.samples ** 2 * 3);
				for (let pixel = 0; pixel < sizeClass.samples ** 2; pixel++) {
					const alpha = rgba[pixel * 4 + 3]!;
					for (let channel = 0; channel < 3; channel++) {
						patch[pixel * 3 + channel] =
							response.gain * rgba[pixel * 4 + channel]! +
							response.offset[channel]! * alpha +
							(1 - alpha) * background[channel]!;
					}
				}
				specimens.push({
					square: { column: specimens.length, row: 0, size: sizeClass.size },
					sizeClass,
					mean: background,
					patch,
					expected: abbreviate(sprite.piece),
				});
			}
		}
	}
	const matcher = chooseMatchers(sprites, specimens, true)(sizeClass);
	for (const { patch, expected } of specimens) {
		const sums = patchSums(matcher, patch);
		const fits = refinePhotoFits(matcher, patch, sums, rankFits(matcher, patch, sums));
		assert.equal(abbreviate(fits[0]!.template.sprite!.piece), expected);
	}
});

test('requires clear red check-glow evidence on a noisy photograph', async () => {
	const sprites = await loadSprites();
	const sprite = sprites.find((candidate) => candidate.piece.player === 2 && candidate.piece.kind.code === 'q')!; // prettier-ignore
	const sizeClass = { size: 64, samples: 24 };
	const rgba = renderSprite(sprite.levels, sizeClass.size, sizeClass.samples);
	const background: RGB = [0.55, 0.48, 0.4];
	for (const [red, expected] of [
		[0, 'q'],
		[0.17, 'q'],
		[0.6, 'rq'],
	] as const) {
		const patch = new Float32Array(sizeClass.samples ** 2 * 3);
		for (let y = 0; y < sizeClass.samples; y++) {
			for (let x = 0; x < sizeClass.samples; x++) {
				const pixel = y * sizeClass.samples + x;
				const alpha = rgba[pixel * 4 + 3]!;
				const noise = 0.08 * Math.sin(2.3 * x + 0.7 * y);
				const glow = glowAt((x + 0.5) / sizeClass.samples, (y + 0.5) / sizeClass.samples);
				for (let channel = 0; channel < 3; channel++) {
					patch[pixel * 3 + channel] = 0.75 * rgba[pixel * 4 + channel]! + 0.08 * alpha + (1 - alpha) * (background[channel]! + (channel === 0 ? red * glow : 0)) + noise; // prettier-ignore
				}
			}
		}
		const square = { column: 0, row: 0, size: sizeClass.size };
		const sampled = { square, sizeClass, patch, mean: background };
		const plane = {
			toImage: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const,
			toBoard: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const,
		};
		const reader: Reader = {
			pic: { width: 24, height: 24, rgb: patch, sat: new Float64Array(25 * 25 * 3) },
			view: { ...plane, pieces: plane, squares: [square], perspective: false },
			tiles: [background, [0.75, 0.65, 0.5]],
			detectsCovers: true,
		};
		const verdict = classify(reader, sampled, chooseMatchers(sprites, [sampled], true));
		assert.equal(verdict.kind, 'piece');
		if (verdict.kind === 'piece') assert.equal(abbreviate(verdict.piece), expected);
	}
});

test('keeps camera noise separate from colored glyphs and opaque foreground', async () => {
	const sprites = await loadSprites();
	const sizeClass = { size: 64, samples: 24 };
	const specimens: (SampledSquare & { patch: Float32Array; expected: string })[] = [];
	for (const background of [
		[0.48, 0.48, 0.48],
		[0.62, 0.45, 0.27],
		[0.43, 0.57, 0.15],
		[0.14, 0.7, 0.72],
	] as RGB[]) {
		for (let capture = 0; capture < 3; capture++) {
			const response = [
				{ gain: [0.64, 0.68, 0.7], offset: [0.15, 0.2, 0.18], wave: [0.8, 1.37], amplitude: 0.012, gamma: 1.05 },
				{ gain: [0.7, 0.68, 0.66], offset: [0.11, 0.15, 0.13], wave: [2.6, 0.6], amplitude: 0.025, gamma: 1 },
				{ gain: [0.58, 0.63, 0.61], offset: [0.16, 0.19, 0.2], wave: [-1.1, 2.2], amplitude: 0.02, gamma: 0.97 },
			][capture]!; // prettier-ignore
			for (const player of [1, 2, 3, 4, 5, 6]) {
				for (const kind of ['p', 'n', 'q', 'gu', 'ha']) {
					const sprite = sprites.find(candidate => candidate.piece.player === player && candidate.piece.kind.code === kind)!; // prettier-ignore
					const rgba = renderSprite(sprite.levels, sizeClass.size, sizeClass.samples);
					const phase = 0.73 * player + 0.41 * specimens.length;
					const patch = new Float32Array(sizeClass.samples ** 2 * 3);
					for (let y = 0; y < sizeClass.samples; y++) {
						for (let x = 0; x < sizeClass.samples; x++) {
							const pixel = y * sizeClass.samples + x;
							const alpha = rgba[pixel * 4 + 3]!;
							// RGB gain, gamma, directional waves and a smooth exposure field are held out
							// from the matcher's shared-gain camera and radial-background fit.
							const shading = 0.015 * (x / 24 - 0.5) + 0.02 * (y / 24 - 0.5);
							for (let c = 0; c < 3; c++) {
								const color = rgba[pixel * 4 + c]! + (1 - alpha) * background[c]!;
								const wave =
									response.amplitude *
									Math.sin(
										response.wave[0]! * x +
											response.wave[1]! * y +
											phase +
											0.3 * c,
									);
								const exposed =
									response.gain[c]! * color +
									response.offset[c]! +
									shading +
									wave;
								patch[pixel * 3 + c] =
									Math.max(0, Math.min(1, exposed)) ** response.gamma;
							}
						}
					}
					const mean = photoBackground(patch, sizeClass.samples).mean;
					specimens.push({ square: { column: specimens.length, row: 0, size: sizeClass.size }, sizeClass, mean, patch, expected: abbreviate(sprite.piece) }); // prettier-ignore
				}
			}
		}
	}
	const matchers = chooseMatchers(sprites, specimens, true);
	for (const specimen of specimens) {
		assert.equal(isPhotographicBackground(specimen.patch, sizeClass.samples), false, specimen.expected); // prettier-ignore
		const reader = cameraReader(specimen.patch, specimen.mean);
		reader.inferred = new Set([`${specimen.square.column},${specimen.square.row}`]);
		const verdict = classify(reader, specimen, matchers);
		assert.equal(verdict.kind, 'piece', specimen.expected);
		if (verdict.kind === 'piece') assert.equal(abbreviate(verdict.piece), specimen.expected);
	}

	let screened = 0;
	for (let phase = 0; phase < 8; phase++) {
		const background: RGB = [0.47, 0.56, 0.23];
		const patch = new Float32Array(24 * 24 * 3);
		for (let y = 0; y < 24; y++)
			for (let x = 0; x < 24; x++)
				for (let c = 0; c < 3; c++)
					patch[(y * 24 + x) * 3 + c] = background[c]! + 0.02 * (x / 24 - 0.5) + 0.01 * (y / 24 - 0.5) + 0.035 * Math.sin(1.4 * x - 0.9 * y + phase + 0.3 * c); // prettier-ignore
		if (isPhotographicBackground(patch, 24)) screened++;
		const square = { column: phase, row: 0, size: 64 };
		const sampled = { square, sizeClass, mean: background, patch };
		assert.equal(classify(cameraReader(patch, background), sampled, matchers).kind, 'empty');
		const inferred = cameraReader(patch, background);
		inferred.inferred = new Set([`${square.column},${square.row}`]);
		assert.equal(classify(inferred, sampled, matchers).kind, 'obscured');
		// An opaque patterned object preserves the bare perimeter but replaces the interior.
		for (let y = 3; y < 21; y++)
			for (let x = 3; x < 21; x++)
				for (let c = 0; c < 3; c++) patch[(y * 24 + x) * 3 + c] = (x + y + c) % 2;
		// This is a different camera observation: create a new patch to avoid reusing its calibration.
		const covered = new Float32Array(patch);
		assert.equal(isPhotographicBackground(covered, 24), false);
		assert.equal(classify(cameraReader(covered, background), { ...sampled, patch: covered }, matchers).kind, 'obscured'); // prettier-ignore
	}
	assert.ok(screened >= 6, 'Most noisy bare interiors should agree with their independent perimeter prediction.'); // prettier-ignore
});

function cameraReader(patch: Float32Array, background: RGB): Reader {
	const plane = { toImage: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, toBoard: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const }; // prettier-ignore
	return {
		pic: { width: 24, height: 24, rgb: patch, sat: new Float64Array(25 * 25 * 3) },
		view: { ...plane, pieces: plane, squares: [], perspective: false },
		tiles: [background, background.map((color) => Math.min(1, color + 0.15)) as RGB],
		detectsCovers: true,
	};
}
