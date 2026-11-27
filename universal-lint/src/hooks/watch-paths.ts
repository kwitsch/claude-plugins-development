#!/usr/bin/env node
/**
 * Command hook for SessionStart and CwdChanged: prints the FileChanged watch list (`hookSpecificOutput.watchPaths`).
 *
 * @remarks
 * A `command` hook because only a command hook returns watchPaths under a managed policy. stdin is read
 * asynchronously to EOF (fd 0 is non-blocking: a sync read throws EAGAIN on a late writer, F05). Writes no file, never
 * calls `process.exit`, fails open (no output). Must not import `../mcp/server.ts` (it starts the server at import).
 *
 * @packageDocumentation
 */
import process from "node:process";
import { json } from "node:stream/consumers";
import { type PostToolUseHookInput, watchPathsHandler } from "./lint-core.js";

try {
  const r = watchPathsHandler((await json(process.stdin)) as PostToolUseHookInput);
  if (r.hookSpecificOutput) process.stdout.write(JSON.stringify(r));
} catch {
  // fail open: no output, exit 0
}
