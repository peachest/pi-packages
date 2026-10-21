// Resolution stubs for importing upstream/worktrunk.ts outside the pi runtime.
// The module's peer deps (@earendil-works/*, typebox) are provided by pi at
// runtime; none of their exports are touched at import time, so dummies suffice.
const STUBS = {
  "@earendil-works/pi-coding-agent":
    "export const SessionManager = {}; export const keyText = () => '';",
  "@earendil-works/pi-ai": "export const StringEnum = () => ({});",
  "@earendil-works/pi-tui":
    "export const Box = class {}; export const Loader = class {}; export const Text = class {};",
  typebox:
    "export const Type = new Proxy({}, { get: () => () => ({}) });",
};

export async function resolve(specifier, context, next) {
  if (specifier in STUBS) {
    return {
      url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
