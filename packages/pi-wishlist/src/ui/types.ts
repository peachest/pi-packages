/* ------------------------------------------------------------------ */
/*  Pi Wishlist — UI type definitions                                 */
/* ------------------------------------------------------------------ */

export interface InlineEditState {
  buffer: string;
  cursor: number;
}

export interface InlineEditChar {
  ch: string;
  start: number;
  end: number;
}

export type WishlistMode =
  | "list"
  | "search"
  | "edit-note"
  | "add-search"
  | "add-note"
  | "remove-confirm";