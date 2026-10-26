/**
 * Entry point of the example package (copy-me template).
 *
 * A package's public surface is its ROOT FILES — import this from outside.
 * Implementation lives in lib/ and is private (enforced by lint:boundaries).
 */
import { greet } from "./lib/impl.ts";

export function exampleGreet(name: string): string {
  return greet(name);
}
