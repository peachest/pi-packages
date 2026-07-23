/* ------------------------------------------------------------------ */
/*  Pi Wishlist — extension entry point                               */
/*                                                                     */
/*  Locales are registered inside i18n-bridge.ts to avoid the async    */
/*  race between two separate IIFEs (P1). This file only delegates.    */
/* ------------------------------------------------------------------ */

export { default } from "./src/main.ts";