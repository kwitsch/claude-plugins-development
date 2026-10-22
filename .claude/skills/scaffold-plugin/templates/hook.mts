#!/usr/bin/env node
// __EVENT__ hook. Reads the hook payload from stdin, writes optional JSON to stdout.
// Exit 0 = continue, exit 2 = block (stderr shown to Claude).
import { readFileSync } from "node:fs";

interface HookInput {
  session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

const input: HookInput = JSON.parse(readFileSync(0, "utf8") || "{}");

// TODO: implement. Example additional context:
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: "" },
  }),
);
