/**
 * The pieces infinitechess.org draws: their ICN codes, their SVG sprites, and the tint each
 * player's copy is drawn in. Voids have no sprite, as they show the sky behind the board.
 */

// Types -----------------------------------------------------------------------

/** A player as ICN numbers them: 0 neutral, 1 white, 2 black, 3 red, 4 blue, 5 yellow, 6 green. */
export type Player = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A color multiplier, as [r, g, b, a]. */
export type Tint = [number, number, number, number];

/** One kind of piece with a sprite. */
export interface PieceKind {
	/** Its ICN code, lowercase. */
	code: string;
	/** The base id of its SVGs, which append the color, like `pawn-white`. */
	svg: string;
	/** The SVG file under `assets/pieces/` holding them. */
	file: string;
}

/** A piece of a player. */
export interface Piece {
	kind: PieceKind;
	player: Player;
}

// Constants -------------------------------------------------------------------

/** Every piece with a sprite. */
// prettier-ignore
export const PIECE_KINDS: PieceKind[] = [
	{ code: 'k', svg: 'king', file: 'classical' },
	{ code: 'q', svg: 'queen', file: 'classical' },
	{ code: 'r', svg: 'rook', file: 'classical' },
	{ code: 'b', svg: 'bishop', file: 'classical' },
	{ code: 'n', svg: 'knight', file: 'classical' },
	{ code: 'p', svg: 'pawn', file: 'classical' },
	{ code: 'am', svg: 'amazon', file: 'amazon' },
	{ code: 'ha', svg: 'hawk', file: 'hawk' },
	{ code: 'ch', svg: 'chancellor', file: 'chancellor' },
	{ code: 'ar', svg: 'archbishop', file: 'archbishop' },
	{ code: 'gu', svg: 'guard', file: 'guard' },
	{ code: 'ca', svg: 'camel', file: 'camel' },
	{ code: 'gi', svg: 'giraffe', file: 'giraffe' },
	{ code: 'ze', svg: 'zebra', file: 'zebra' },
	{ code: 'ce', svg: 'centaur', file: 'centaur' },
	{ code: 'rq', svg: 'royalQueen', file: 'royalQueen' },
	{ code: 'rc', svg: 'royalCentaur', file: 'royalCentaur' },
	{ code: 'nr', svg: 'knightrider', file: 'knightrider' },
	{ code: 'hu', svg: 'huygen', file: 'huygen' },
	{ code: 'ro', svg: 'rose', file: 'rose' },
	{ code: 'ob', svg: 'obstacle', file: 'obstacle' },
];

/** The ICN code of a void. */
export const VOID_CODE = 'vo';

/** Codes of the pieces only the neutral player owns. */
const NEUTRAL_CODES = new Set(['ob']);

/** Every player that owns pieces of their own. */
const COLORED_PLAYERS: Player[] = [1, 2, 3, 4, 5, 6];

/** The tint each player's pieces are drawn in. */
const PLAYER_TINTS: Record<Player, Tint> = {
	0: [0.5, 0.5, 0.5, 1],
	1: [1, 1, 1, 1],
	2: [1, 1, 1, 1],
	3: [1, 0.17, 0.17, 1],
	4: [0.23, 0.23, 1, 1],
	5: [1, 1, 0.1, 1],
	6: [0.1, 1, 0.1, 1],
};

/** The tint of obstacles, which overrides the neutral player's. */
const OBSTACLE_TINT: Tint = [0.08, 0.08, 0.08, 1];

/** Pieces with a royal look-alike, by code. */
const ROYAL_COUNTERPARTS: Record<string, string> = { q: 'rq', ce: 'rc' };

// Functions -------------------------------------------------------------------

/** Every piece the site can draw, each player's copy separately. */
export function allPieces(): Piece[] {
	return PIECE_KINDS.flatMap((kind) => {
		const owners: Player[] = NEUTRAL_CODES.has(kind.code) ? [0] : COLORED_PLAYERS;
		return owners.map((player) => ({ kind, player }));
	});
}

/** The ids of the SVGs a piece may be drawn from, the preferred first. */
export function svgIdsOf(piece: Piece): string[] {
	const colors = piece.player === 0 ? ['neutral', 'white'] : piece.player === 2 ? ['black', 'neutral'] : ['white', 'neutral']; // prettier-ignore
	return colors.map((color) => `${piece.kind.svg}-${color}`);
}

/** The tint a piece is drawn in. */
export function tintOf(piece: Piece): Tint {
	return piece.kind.code === 'ob' ? OBSTACLE_TINT : PLAYER_TINTS[piece.player];
}

/** The same player's royal look-alike of a piece, if it has one. */
export function royalCounterpart(piece: Piece): Piece | undefined {
	const code = ROYAL_COUNTERPARTS[piece.kind.code];
	if (code === undefined) return undefined;
	return { kind: PIECE_KINDS.find((kind) => kind.code === code)!, player: piece.player };
}

/** A piece's ICN abbreviation: uppercase for white, lowercase for black and neutral, else numbered. */
export function abbreviate(piece: Piece): string {
	if (piece.player === 1) return piece.kind.code.toUpperCase();
	if (piece.player === 0 || piece.player === 2) return piece.kind.code;
	return `${piece.player}${piece.kind.code}`;
}
