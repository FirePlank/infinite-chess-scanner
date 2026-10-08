/**
 * Loads a screenshot, and samples squares of the board out of it through the board's homography,
 * box-averaging exactly through a summed-area table.
 */

import type { RGB } from './color.js';
import type { Homography } from './homography.js';

import sharp from 'sharp';

// Types -----------------------------------------------------------------------

/** An image as float RGB in [0,1], row-major, with its summed-area table. */
export interface Picture {
	width: number;
	height: number;
	rgb: Float32Array;
	/** Summed-area table, (width+1) x (height+1) x 3. */
	sat: Float64Array;
}

// Constants -------------------------------------------------------------------

/** The most points read per patch sample along each axis, averaging the pixels it covers at an angle. */
const MAX_SUBSAMPLES = 6;

// Functions -------------------------------------------------------------------

/** Decodes an image file or buffer into a {@link Picture}. */
export async function loadPicture(input: string | Buffer): Promise<Picture> {
	const { data, info } = await sharp(input)
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const { width, height } = info;
	const rgb = new Float32Array(width * height * 3);
	for (let i = 0; i < rgb.length; i++) rgb[i] = data[i]! / 255;

	const stride = (width + 1) * 3;
	const sat = new Float64Array(stride * (height + 1));
	for (let y = 0; y < height; y++) {
		let r = 0;
		let g = 0;
		let b = 0;
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			r += rgb[i]!;
			g += rgb[i + 1]!;
			b += rgb[i + 2]!;
			const at = (y + 1) * stride + (x + 1) * 3;
			sat[at] = sat[at - stride]! + r;
			sat[at + 1] = sat[at - stride + 1]! + g;
			sat[at + 2] = sat[at - stride + 2]! + b;
		}
	}
	return { width, height, rgb, sat };
}

/** The color of pixel i. */
export function colorAt(pic: Picture, i: number): RGB {
	return [pic.rgb[i * 3]!, pic.rgb[i * 3 + 1]!, pic.rgb[i * 3 + 2]!];
}

/**
 * Samples a square region of the board, from board-grid point (u, v) across an extent, down to a
 * samples x samples RGB patch, each sample averaging the pixels its part of the region covers.
 */
export function samplePatch(
	pic: Picture,
	toImage: Homography,
	[left, top]: [number, number],
	extent: number,
	samples: number,
): Float32Array {
	const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = toImage as [number, number, number, number, number, number, number, number, number]; // prettier-ignore
	if (h1 === 0 && h3 === 0 && h6 === 0 && h7 === 0) {
		return sampleAligned(pic, h2 + left * h0, h5 + top * h4, (h0 * extent) / samples, samples);
	}
	// At an angle, a sample's part of the square is a slanted quadrilateral on screen: points
	// spread across it average the pixels it covers.
	const patch = new Float32Array(samples * samples * 3);
	const step = extent / samples;
	for (let sy = 0; sy < samples; sy++) {
		for (let sx = 0; sx < samples; sx++) {
			const [u, v] = [left + (sx + 0.5) * step, top + (sy + 0.5) * step];
			const w = h6 * u + h7 * v + h8;
			const x = (h0 * u + h1 * v + h2) / w;
			const y = (h3 * u + h4 * v + h5) / w;
			const across = Math.max(Math.abs(h0 - x * h6) + Math.abs(h3 - y * h6), Math.abs(h1 - x * h7) + Math.abs(h4 - y * h7)) * (step / w); // prettier-ignore
			const points = Math.min(MAX_SUBSAMPLES, Math.max(1, Math.ceil(2 * across)));
			const at = (sy * samples + sx) * 3;
			for (let j = 0; j < points; j++) {
				const pv = top + (sy + (j + 0.5) / points) * step;
				for (let i = 0; i < points; i++) {
					const pu = left + (sx + (i + 0.5) / points) * step;
					const pw = h6 * pu + h7 * pv + h8;
					addBilinear(pic, (h0 * pu + h1 * pv + h2) / pw, (h3 * pu + h4 * pv + h5) / pw, 1 / (points * points), patch, at); // prettier-ignore
				}
			}
		}
	}
	return patch;
}

/** Adds a weighted bilinear read of the image at a point, pixel centers being half-integer. */
function addBilinear(
	pic: Picture,
	x: number,
	y: number,
	weight: number,
	out: Float32Array,
	at: number,
): void {
	const fx = Math.min(Math.max(x - 0.5, 0), pic.width - 1);
	const fy = Math.min(Math.max(y - 0.5, 0), pic.height - 1);
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const x1 = Math.min(x0 + 1, pic.width - 1);
	const y1 = Math.min(y0 + 1, pic.height - 1);
	const tx = fx - x0;
	const ty = fy - y0;
	const [a, b, c, d] = [(y0 * pic.width + x0) * 3, (y0 * pic.width + x1) * 3, (y1 * pic.width + x0) * 3, (y1 * pic.width + x1) * 3]; // prettier-ignore
	for (let k = 0; k < 3; k++) {
		const top = pic.rgb[a + k]! * (1 - tx) + pic.rgb[b + k]! * tx;
		const bottom = pic.rgb[c + k]! * (1 - tx) + pic.rgb[d + k]! * tx;
		out[at + k]! += weight * (top * (1 - ty) + bottom * ty);
	}
}

/**
 * Samples a square of a board seen straight down, whose samples tile it in screen rectangles that
 * share their corners, each read from the summed-area table once.
 */
function sampleAligned(
	pic: Picture,
	left: number,
	top: number,
	step: number,
	samples: number,
): Float32Array {
	const sides = samples + 1;
	const corners = new Float64Array(sides * sides * 3);
	for (let j = 0; j < sides; j++) {
		for (let i = 0; i < sides; i++) readSAT(pic, left + i * step, top + j * step, corners, (j * sides + i) * 3); // prettier-ignore
	}
	const patch = new Float32Array(samples * samples * 3);
	const area = step * step;
	for (let sy = 0; sy < samples; sy++) {
		for (let sx = 0; sx < samples; sx++) {
			const topLeft = (sy * sides + sx) * 3;
			const bottomLeft = topLeft + sides * 3;
			for (let c = 0; c < 3; c++) {
				const sum = corners[bottomLeft + 3 + c]! - corners[topLeft + 3 + c]! - corners[bottomLeft + c]! + corners[topLeft + c]!; // prettier-ignore
				patch[(sy * samples + sx) * 3 + c] = sum / area;
			}
		}
	}
	return patch;
}

/** Bilinearly reads the summed-area table at a fractional point, which integrates the image exactly. */
function readSAT(pic: Picture, x: number, y: number, out: Float64Array, offset: number): void {
	x = Math.min(Math.max(x, 0), pic.width);
	y = Math.min(Math.max(y, 0), pic.height);
	const x0 = Math.min(Math.floor(x), pic.width - 1);
	const y0 = Math.min(Math.floor(y), pic.height - 1);
	const fx = x - x0;
	const fy = y - y0;
	const stride = (pic.width + 1) * 3;
	const top = y0 * stride + x0 * 3;
	const bottom = top + stride;
	for (let c = 0; c < 3; c++) {
		const upper = pic.sat[top + c]! * (1 - fx) + pic.sat[top + 3 + c]! * fx;
		const lower = pic.sat[bottom + c]! * (1 - fx) + pic.sat[bottom + 3 + c]! * fx;
		out[offset + c] = upper * (1 - fy) + lower * fy;
	}
}
