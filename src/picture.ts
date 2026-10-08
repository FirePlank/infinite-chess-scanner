/**
 * Loads a screenshot, and box-averages any rectangle of it exactly through a summed-area table.
 */

import type { RGB } from './color.js';

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
		const rowSum: RGB = [0, 0, 0];
		for (let x = 0; x < width; x++) {
			for (let c = 0; c < 3; c++) {
				rowSum[c]! += rgb[(y * width + x) * 3 + c]!;
				sat[(y + 1) * stride + (x + 1) * 3 + c] =
					sat[y * stride + (x + 1) * 3 + c]! + rowSum[c]!;
			}
		}
	}
	return { width, height, rgb, sat };
}

/** The color of pixel i. */
export function colorAt(pic: Picture, i: number): RGB {
	return [pic.rgb[i * 3]!, pic.rgb[i * 3 + 1]!, pic.rgb[i * 3 + 2]!];
}

/** Box-averages a square of the image down to a samples x samples RGB patch. */
export function samplePatch(
	pic: Picture,
	left: number,
	top: number,
	size: number,
	samples: number,
): Float32Array {
	const patch = new Float32Array(samples * samples * 3);
	const step = size / samples;
	const corners = new Float64Array(12);
	for (let sy = 0; sy < samples; sy++) {
		for (let sx = 0; sx < samples; sx++) {
			const x = left + sx * step;
			const y = top + sy * step;
			readSAT(pic, x, y, corners, 0);
			readSAT(pic, x + step, y, corners, 3);
			readSAT(pic, x, y + step, corners, 6);
			readSAT(pic, x + step, y + step, corners, 9);
			for (let c = 0; c < 3; c++) {
				const sum = corners[9 + c]! - corners[3 + c]! - corners[6 + c]! + corners[c]!;
				patch[(sy * samples + sx) * 3 + c] = sum / (step * step);
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
