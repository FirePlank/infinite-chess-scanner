/**
 * Homographies: the projective maps between the board's plane and the screen. The board, pieces
 * included, is one flat plane, so a single homography places all of it, whether the screenshot
 * looks straight down or at an angle.
 */

// Types -----------------------------------------------------------------------

/** A 3x3 projective map, row-major. */
export type Homography = number[];

/** A 2D point. */
export type Point = [number, number];

// Functions -------------------------------------------------------------------

/** Maps a point through a homography. */
export function project(h: Homography, x: number, y: number): Point {
	const w = h[6]! * x + h[7]! * y + h[8]!;
	return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
}

/** Whether a point maps in front of the camera, rather than behind it. */
export function isInFront(h: Homography, x: number, y: number): boolean {
	return h[6]! * x + h[7]! * y + h[8]! > 0;
}

/** Composes two homographies: first b, then a. */
export function compose(a: Homography, b: Homography): Homography {
	const r = new Array<number>(9).fill(0);
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			for (let k = 0; k < 3; k++) r[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
		}
	}
	return r;
}

/** The inverse of a homography. */
export function invert(m: Homography): Homography {
	const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number]; // prettier-ignore
	const A = e * i - f * h;
	const B = f * g - d * i;
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	const adjugate = [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d]; // prettier-ignore
	return adjugate.map((v) => v / det);
}

/**
 * How far a homography moves its output per unit of input at a point: the longer of the
 * output's derivatives along the input's two axes.
 */
export function stretch(h: Homography, x: number, y: number): number {
	const w = h[6]! * x + h[7]! * y + h[8]!;
	const [px, py] = project(h, x, y);
	const dx = Math.hypot(h[0]! - px * h[6]!, h[3]! - py * h[6]!) / w;
	const dy = Math.hypot(h[1]! - px * h[7]!, h[4]! - py * h[7]!) / w;
	return Math.max(dx, dy);
}

/** The least-squares homography mapping each pair's first point to its second, by normalized DLT. */
export function fitHomography(pairs: [Point, Point][]): Homography {
	const from = normalizer(pairs.map((pair) => pair[0]));
	const to = normalizer(pairs.map((pair) => pair[1]));
	const rows: number[][] = [];
	const targets: number[] = [];
	for (const [a, b] of pairs) {
		const [u, v] = project(from, a[0], a[1]);
		const [x, y] = project(to, b[0], b[1]);
		rows.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
		targets.push(x);
		rows.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
		targets.push(y);
	}
	const fitted = [...solveLeastSquares(rows, targets), 1];
	const h = compose(invert(to), compose(fitted, from));
	return h.map((v) => v / h[8]!);
}

/** The similarity moving points to their centroid and scaling them to an average distance of √2. */
function normalizer(points: Point[]): Homography {
	const mx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
	const my = points.reduce((sum, p) => sum + p[1], 0) / points.length;
	const spread = points.reduce((sum, p) => sum + Math.hypot(p[0] - mx, p[1] - my), 0) / points.length; // prettier-ignore
	const k = Math.SQRT2 / (spread || 1);
	return [k, 0, -k * mx, 0, k, -k * my, 0, 0, 1];
}

/** Solves the normal equations of an overdetermined linear system by Gauss-Jordan elimination. */
function solveLeastSquares(rows: number[][], targets: number[]): number[] {
	const n = rows[0]!.length;
	const m = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
	rows.forEach((row, r) => {
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) m[i]![j]! += row[i]! * row[j]!;
			m[i]![n]! += row[i]! * targets[r]!;
		}
	});
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let r = col + 1; r < n; r++)
			if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
		[m[col], m[pivot]] = [m[pivot]!, m[col]!];
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const factor = m[r]![col]! / m[col]![col]!;
			for (let j = col; j <= n; j++) m[r]![j]! -= factor * m[col]![j]!;
		}
	}
	return m.map((row, i) => row[n]! / row[i]!);
}
