/**
 * Renders the piece sprites exactly as the site's WebGL does: each SVG rasterized at 512px and
 * tinted in linear light, mipmapped from unpremultiplied texels with transparent ones black, then
 * sampled trilinearly with a -0.5 LOD bias and alpha-blended.
 */

import type { Piece, Tint } from './pieces.js';

import fs from 'node:fs';
import sharp from 'sharp';

import { toLinear, toSRGB } from './color.js';
import { allPieces, svgIdsOf, tintOf } from './pieces.js';

// Types -----------------------------------------------------------------------

/** One mipmap level of a piece texture: unpremultiplied color and alpha, row-major. */
export interface MipLevel {
	size: number;
	rgba: Float32Array;
}

/** A piece and its texture's mipmap levels, from the finest kept one down to 1x1. */
export interface Sprite {
	piece: Piece;
	levels: MipLevel[];
}

// Constants -------------------------------------------------------------------

/** The resolution the site rasterizes piece SVGs at for their textures. */
const TEXTURE_SIZE = 512;

/** The finest mipmap level kept. Squares too large to sample coarser levels are box-averaged from it. */
const FINEST_KEPT_LEVEL = 3;

/** The mipmap LOD bias of the site's piece shader. */
const LOD_BIAS = -0.5;

/** Where the build caches the rendered sprites. */
const CACHE = new URL('./sprites.bin', import.meta.url);

/** Scratch texels of {@link sampleTexture}, reused across its calls. */
const FINE_TEXEL = new Float32Array(4);
const COARSE_TEXEL = new Float32Array(4);

// Building --------------------------------------------------------------------

/** The sprite of every piece the site can draw, from the build's cache when it has one. */
export async function loadSprites(): Promise<Sprite[]> {
	return readCache() ?? renderSprites();
}

/** Renders every sprite and saves the cache beside this module, for later loads to skip rendering. */
export async function cacheSprites(): Promise<void> {
	const sprites = await renderSprites();
	const finest = sprites.map((sprite) => sprite.levels[0]!.rgba);
	const data = new Float32Array(finest.reduce((sum, rgba) => sum + rgba.length, 0));
	finest.reduce((offset, rgba) => (data.set(rgba, offset), offset + rgba.length), 0);
	fs.writeFileSync(CACHE, new Uint8Array(data.buffer));
}

/** The cached sprites, if the build cached them for the same pieces. */
function readCache(): Sprite[] | undefined {
	if (!fs.existsSync(CACHE)) return undefined;
	const pieces = allPieces();
	const size = TEXTURE_SIZE >> FINEST_KEPT_LEVEL;
	const texels = size * size * 4;
	const bytes = fs.readFileSync(CACHE);
	if (bytes.byteLength !== pieces.length * texels * 4) return undefined;
	const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
	return pieces.map((piece, i) => {
		const levels: MipLevel[] = [{ size, rgba: data.slice(i * texels, (i + 1) * texels) }];
		while (levels.at(-1)!.size > 1) levels.push(halve(levels.at(-1)!));
		return { piece, levels };
	});
}

/** Renders the sprite of every piece the site can draw from its SVG. */
async function renderSprites(): Promise<Sprite[]> {
	const svgsById = readPieceSVGs();
	const rasters = new Map<string, Promise<Buffer>>();
	const pending = allPieces().map((piece) => {
		const id = svgIdsOf(piece).find((candidate) => svgsById.has(candidate))!;
		if (!rasters.has(id)) rasters.set(id, rasterize(svgsById.get(id)!));
		return { piece, raster: rasters.get(id)! };
	});
	const sprites: Sprite[] = [];
	for (const { piece, raster } of pending) {
		sprites.push({ piece, levels: buildMipmaps(await raster, tintOf(piece)) });
	}
	return sprites;
}

/** Every piece `<svg>` in the bundled piece files, keyed by its id (e.g. `pawn-white`). */
function readPieceSVGs(): Map<string, string> {
	const svgsById = new Map<string, string>();
	const folder = new URL('../assets/pieces/', import.meta.url);
	for (const name of fs.readdirSync(folder)) {
		const file = fs.readFileSync(new URL(name, folder), 'utf8');
		for (const [svg, id] of file.matchAll(/<svg\b[^>]*\sid="([^"]*)"[\s\S]*?<\/svg>/g)) {
			svgsById.set(id!, svg);
		}
	}
	return svgsById;
}

/** Rasterizes an SVG at the site's texture size, to 8-bit unpremultiplied RGBA. */
async function rasterize(svg: string): Promise<Buffer> {
	const sized = svg.replace('<svg', `<svg width="${TEXTURE_SIZE}" height="${TEXTURE_SIZE}"`);
	return sharp(Buffer.from(sized)).ensureAlpha().raw().toBuffer();
}

/**
 * Tints a raster and builds its mipmap levels from the finest kept one down to 1x1. The tint is
 * multiplied in linear light, as the site's SVG filter does.
 */
function buildMipmaps(raster: Buffer, tint: Tint): MipLevel[] {
	const tinted = [0, 1, 2].map((c) =>
		Float32Array.from({ length: 256 }, (_, v) => toSRGB(toLinear(v / 255) * tint[c]!)),
	);
	const factor = 2 ** FINEST_KEPT_LEVEL;
	const size = TEXTURE_SIZE / factor;
	const rgba = new Float32Array(size * size * 4);
	const share = 1 / (factor * factor);
	for (let y = 0; y < TEXTURE_SIZE; y++) {
		for (let x = 0; x < TEXTURE_SIZE; x++) {
			const i = (y * TEXTURE_SIZE + x) * 4;
			if (raster[i + 3] === 0) continue; // Transparent texels are black.
			const at = ((y >> FINEST_KEPT_LEVEL) * size + (x >> FINEST_KEPT_LEVEL)) * 4;
			for (let c = 0; c < 3; c++) rgba[at + c]! += tinted[c]![raster[i + c]!]! * share;
			rgba[at + 3]! += (raster[i + 3]! / 255) * tint[3] * share;
		}
	}
	const levels: MipLevel[] = [{ size, rgba }];
	while (levels.at(-1)!.size > 1) levels.push(halve(levels.at(-1)!));
	return levels;
}

/** The next mipmap level: each texel the plain average of the 2x2 below it. */
function halve(level: MipLevel): MipLevel {
	const size = level.size / 2;
	const rgba = new Float32Array(size * size * 4);
	const row = level.size * 4;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const from = (2 * y * level.size + 2 * x) * 4;
			for (let c = 0; c < 4; c++) {
				const sum =
					level.rgba[from + c]! +
					level.rgba[from + 4 + c]! +
					level.rgba[from + row + c]! +
					level.rgba[from + row + 4 + c]!;
				rgba[(y * size + x) * 4 + c] = sum / 4;
			}
		}
	}
	return { size, rgba };
}

// Sampling --------------------------------------------------------------------

/**
 * Renders a piece as the site draws it on a square of the given size, sampled at a resolution,
 * to premultiplied RGBA.
 */
export function renderSprite(
	levels: MipLevel[],
	squareSize: number,
	samples: number,
): Float32Array {
	const lod = textureLod(squareSize);
	if (lod < 0) return boxAverage(levels[0]!, samples);
	const out = new Float32Array(samples * samples * 4);
	const texel = new Float32Array(4);
	for (let sy = 0; sy < samples; sy++) {
		for (let sx = 0; sx < samples; sx++) {
			sampleTexture(levels, lod, (sx + 0.5) / samples, (sy + 0.5) / samples, texel);
			out.set(texel, (sy * samples + sx) * 4);
		}
	}
	return out;
}

/** The mipmap LOD the site's shader samples a piece at on a square of this size, counted from the finest kept level. */
export function textureLod(squareSize: number): number {
	return Math.log2(TEXTURE_SIZE / squareSize) + LOD_BIAS - FINEST_KEPT_LEVEL;
}

/**
 * Samples a piece texture at a point of its square, trilinearly between two mipmap levels, to
 * premultiplied RGBA. An LOD finer than the kept levels falls back to the finest kept one.
 */
export function sampleTexture(
	levels: MipLevel[],
	lod: number,
	u: number,
	v: number,
	out: Float32Array,
): void {
	const index = Math.min(Math.max(Math.floor(lod), 0), levels.length - 2);
	const weight = Math.min(Math.max(lod - index, 0), 1);
	sampleBilinear(levels[index]!, u, v, FINE_TEXEL);
	sampleBilinear(levels[index + 1]!, u, v, COARSE_TEXEL);
	const alpha = FINE_TEXEL[3]! + (COARSE_TEXEL[3]! - FINE_TEXEL[3]!) * weight;
	for (let c = 0; c < 3; c++)
		out[c] = (FINE_TEXEL[c]! + (COARSE_TEXEL[c]! - FINE_TEXEL[c]!) * weight) * alpha;
	out[3] = alpha;
}

/** Bilinearly samples a mipmap level at texture coordinates in [0,1], clamping at its edges. */
function sampleBilinear(level: MipLevel, u: number, v: number, out: Float32Array): void {
	const n = level.size;
	const tx = Math.min(Math.max(u * n - 0.5, 0), n - 1);
	const ty = Math.min(Math.max(v * n - 0.5, 0), n - 1);
	const x0 = Math.floor(tx);
	const y0 = Math.floor(ty);
	const x1 = Math.min(x0 + 1, n - 1);
	const y1 = Math.min(y0 + 1, n - 1);
	const fx = tx - x0;
	const fy = ty - y0;
	for (let c = 0; c < 4; c++) {
		const top =
			level.rgba[(y0 * n + x0) * 4 + c]! * (1 - fx) + level.rgba[(y0 * n + x1) * 4 + c]! * fx;
		const bottom =
			level.rgba[(y1 * n + x0) * 4 + c]! * (1 - fx) + level.rgba[(y1 * n + x1) * 4 + c]! * fx;
		out[c] = top * (1 - fy) + bottom * fy;
	}
}

/** Box-averages a mipmap level down to samples x samples premultiplied RGBA, for squares too large to mipmap. */
function boxAverage(level: MipLevel, samples: number): Float32Array {
	const n = level.size;
	const out = new Float32Array(samples * samples * 4);
	for (let sy = 0; sy < samples; sy++) {
		const y0 = Math.floor((sy * n) / samples);
		const y1 = Math.max(y0 + 1, Math.floor(((sy + 1) * n) / samples));
		for (let sx = 0; sx < samples; sx++) {
			const x0 = Math.floor((sx * n) / samples);
			const x1 = Math.max(x0 + 1, Math.floor(((sx + 1) * n) / samples));
			const count = (x1 - x0) * (y1 - y0);
			const at = (sy * samples + sx) * 4;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const alpha = level.rgba[(y * n + x) * 4 + 3]!;
					for (let c = 0; c < 3; c++)
						out[at + c]! += (level.rgba[(y * n + x) * 4 + c]! * alpha) / count;
					out[at + 3]! += alpha / count;
				}
			}
		}
	}
	return out;
}
