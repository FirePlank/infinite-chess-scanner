/**
 * Loads a screenshot, and samples squares of the board out of it through the board's homography,
 * box-averaging exactly through a summed-area table.
 */

import type { RGB } from './color.js';
import type { Homography } from './homography.js';
import type { Square } from './view.js';

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
 * Samples a square down to a samples x samples RGB patch, each sample the average of the screen
 * rectangle its part of the square spans. Seen straight down that's exactly the part; at an angle,
 * the rectangle around it.
 */
export function samplePatch(
	pic: Picture,
	toImage: Homography,
	square: Square,
	samples: number,
): Float32Array {
	const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = toImage as [number, number, number, number, number, number, number, number, number]; // prettier-ignore
	const patch = new Float32Array(samples * samples * 3);
	const corners = new Float64Array(12);
	const half = 0.5 / samples;
	for (let sy = 0; sy < samples; sy++) {
		const v = square.row + (sy + 0.5) / samples;
		for (let sx = 0; sx < samples; sx++) {
			const u = square.column + (sx + 0.5) / samples;
			const w = h6 * u + h7 * v + h8;
			const x = (h0 * u + h1 * v + h2) / w;
			const y = (h3 * u + h4 * v + h5) / w;
			// Half the sample's extent on screen along each axis, from the homography's derivatives.
			const spanX = (Math.abs(h0 - x * h6) + Math.abs(h1 - x * h7)) * (half / w);
			const spanY = (Math.abs(h3 - y * h6) + Math.abs(h4 - y * h7)) * (half / w);
			readSAT(pic, x - spanX, y - spanY, corners, 0);
			readSAT(pic, x + spanX, y - spanY, corners, 3);
			readSAT(pic, x - spanX, y + spanY, corners, 6);
			readSAT(pic, x + spanX, y + spanY, corners, 9);
			const area = 4 * spanX * spanY;
			const at = (sy * samples + sx) * 3;
			for (let c = 0; c < 3; c++) {
				patch[at + c] = (corners[9 + c]! - corners[3 + c]! - corners[6 + c]! + corners[c]!) / area; // prettier-ignore
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
