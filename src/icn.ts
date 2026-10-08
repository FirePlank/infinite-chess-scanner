/**
 * Writes a read position as ICN (Infinite Chess Notation), the format infinitechess.org pastes.
 */

// Types -----------------------------------------------------------------------

/** A piece on the board, by its ICN abbreviation. */
export interface PlacedPiece {
	abbreviation: string;
	x: number;
	y: number;
}

/** The ranks each side promotes on. */
export interface Promotion {
	white: number[];
	black: number[];
}

/** The inclusive playable area, null on sides without a border. */
export interface WorldBorder {
	left: number | null;
	right: number | null;
	bottom: number | null;
	top: number | null;
}

// Functions -------------------------------------------------------------------

/**
 * Writes an ICN with white to move on move 1, and the promotion ranks and world border if any.
 * Special rights are never written, as a screenshot can't show them.
 */
export function writeIcn(
	pieces: PlacedPiece[],
	promotion: Promotion | undefined,
	worldBorder: WorldBorder | undefined,
): string {
	const fields = ['w', '1'];
	if (promotion) fields.push(`(${promotion.white.join(',')}|${promotion.black.join(',')})`);
	if (worldBorder) {
		const { left, right, bottom, top } = worldBorder;
		fields.push([left, right, bottom, top].map((side) => side ?? '_').join(','));
	}
	if (pieces.length > 0)
		fields.push(pieces.map((p) => `${p.abbreviation}${p.x},${p.y}`).join('|'));
	return fields.join(' ');
}
