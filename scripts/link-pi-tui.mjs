// @earendil-works/pi-tui is not published to the registry — it ships bundled
// inside @earendil-works/pi-coding-agent. npm therefore cannot install it as a
// top-level dependency, and `npm install` wipes any manual symlink. This
// postinstall script recreates the symlink so vitest can resolve it.
//
// Links node_modules/@earendil-works/pi-tui → ./pi-coding-agent/node_modules/@earendil-works/pi-tui
// (the copy bundled with the locally installed pi-coding-agent, version-matched).
import { symlink, rm, stat, access } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "node_modules", "@earendil-works", "pi-tui");
const source = join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
  "@earendil-works",
  "pi-tui",
);

try {
  await access(join(source, "package.json"));
} catch {
  // Bundled pi-tui not present (pi-coding-agent layout changed?) — skip silently.
  process.exit(0);
}

// Replace existing entry (symlink, dir, or stale file) with a relative symlink.
await rm(target, { recursive: true, force: true });
await symlink(relative(dirname(target), source), target, "dir");
console.log("postinstall: linked @earendil-works/pi-tui →", relative(dirname(target), source));
