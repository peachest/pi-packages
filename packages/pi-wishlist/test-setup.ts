/* ------------------------------------------------------------------ */
/*  Vitest setup: global mock i18n-bridge                             */
/*                                                                     */
/*  All tests except i18n-bridge.test.ts call t(key, fallback) which   */
/*  should simply return the fallback (English literal). This setup    */
/*  file runs before each test file to mock the bridge module.         */
/*                                                                     */
/*  Individual test files that import add.ts / remove.ts etc. use      */
/*  vi.doMock("../state/i18n-bridge.ts", ...) in their beforeEach —    */
/*  this global mock provides a sensible default for any module that   */
/*  imports i18n-bridge.ts directly without explicit mock.             */
/* ------------------------------------------------------------------ */

import { vi } from "vitest";

// Ensure t() returns the fallback in all tests
vi.mock("./src/state/i18n-bridge.ts", () => ({
  t: (key: string, fallback: string) => fallback,
  I18N_NAMESPACE: "pi-wishlist",
  bridge: { i18nAvailable: false },
}));