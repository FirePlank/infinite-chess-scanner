/**
 * Color math shared across the scanner.
 */

// Types -----------------------------------------------------------------------

/** A color with channels in [0, 1]. */
export type RGB = [number, number, number];

// Functions -------------------------------------------------------------------

/** Euclidean distance between two colors. */
export function colorDistance(a: RGB, b: RGB): number {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Perceived brightness of a color. */
export function luminance(c: RGB): number {
	return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

/** Converts an sRGB channel to linear light. */
export function toLinear(v: number): number {
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Converts a linear-light channel to sRGB. */
export function toSRGB(v: number): number {
	return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}
