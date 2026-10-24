/**
 * The limits on what the board member sends meeting support, shared by the
 * routes that check them and the view that keeps within them. Imports
 * nothing, so the view's bundle takes nothing of the server's with it.
 */

/** The longest notes the package takes, about twenty pages of text. */
export const MAX_NOTES_LENGTH = 50_000;

/** The longest request the board member adds to an agenda draft. */
export const MAX_INSTRUCTIONS_LENGTH = 2_000;
