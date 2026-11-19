// In-process access to the built handler for the unit tests, with an isolated HOME: the handler reads user settings
// and appends `~/.local/bin` to PATH, neither of which may come from the developer's machine.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatPre as builtFormatPre } from "../../plugin/mcp/handlers.mjs";

process.env.HOME = mkdtempSync(path.join(tmpdir(), "uf-home-"));
delete process.env.CLAUDE_CONFIG_DIR;

/** A hook result with every field present: a test that reads one on a `{}` result fails its assertion. */
export interface HookOut {
  /** The hook output Claude Code reads. */
  hookSpecificOutput: {
    /** The hook event. */
    hookEventName: string;
    /** The notice for the model. */
    additionalContext: string;
    /** The rewritten tool input, Write and Edit fields together. */
    updatedInput: { file_path: string; content: string; old_string: string; new_string: string; replace_all: boolean };
  };
}

/** The hook input fields the handler reads. */
export interface HookIn {
  /** The session's working directory. */
  cwd: string;
  /** The session's scratchpad directory, as the hook's `input` template passes it. */
  scratchpad_dir?: string;
  /** `Write` or `Edit`. */
  tool_name: string;
  /** The tool's input. */
  tool_input: Record<string, unknown>;
}

/**
 * Calls the built `formatPre`.
 *
 * @param args - The hook input.
 * @returns The hook result.
 */
export const formatPre = (args: HookIn): Promise<HookOut> => builtFormatPre(args) as Promise<HookOut>;

/**
 * `formatPre` for a Write.
 *
 * @param cwd - The session's working directory.
 * @param file - The target file.
 * @param content - The content to write.
 * @returns The hook result.
 */
export const preWrite = (cwd: string, file: string, content: string): Promise<HookOut> => formatPre({ cwd, tool_name: "Write", tool_input: { file_path: file, content } });

/**
 * `formatPre` for an Edit.
 *
 * @param cwd - The session's working directory.
 * @param file - The target file.
 * @param old_string - The text to replace.
 * @param new_string - Its replacement.
 * @returns The hook result.
 */
export const preEdit = (cwd: string, file: string, old_string: string, new_string: string): Promise<HookOut> => formatPre({ cwd, tool_name: "Edit", tool_input: { file_path: file, old_string, new_string } });

/**
 * A fresh temporary directory.
 *
 * @param prefix - Its name prefix.
 * @returns The directory path.
 */
export const tmp = (prefix: string): string => mkdtempSync(path.join(tmpdir(), prefix));
