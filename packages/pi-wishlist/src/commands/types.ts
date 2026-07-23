/** Shared result type for all command modules. */
export type CommandResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };