#!/usr/bin/env node
// Validate plugin/hooks/hooks.json and generate src/mcp/hook-inputs.d.mts (the argument types of every MCP
// tool the hooks call) from its `input` templates. hooks.json is the contract: Claude Code builds each tool
// call's arguments from those templates, so the types are derived from it, never written by hand.
//
//   node scripts/hooks.mts [root]          validate, then (re)write the types
//   node scripts/hooks.mts --check [root]  validate and fail when the committed types are stale (lint/CI)
//
// root defaults to the plugin dir (the parent of scripts/); tests pass a scratch copy.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** CLI arguments. */
const args = process.argv.slice(2);
/** `--check`: verify only, write nothing. */
const check = args[0] === "--check";
/** The plugin directory. */
const ROOT = path.resolve(
  (check ? args[1] : args[0])
    ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
/** The hook contract. */
const HOOKS = path.join(ROOT, "plugin/hooks/hooks.json");
/** The generated types. */
const OUT = path.join(ROOT, "src/mcp/hook-inputs.d.mts");

/** Hook input fields every event carries (cc-reference hooks reference, "Input"). `*` = any sub-path. */
const COMMON = [
  "session_id",
  "prompt_id",
  "transcript_path",
  "cwd",
  "scratchpad_dir",
  "permission_mode",
  "hook_event_name",
  "agent_id",
  "agent_type",
  "effort.level",
];
/** Input fields of the tool events. */
const TOOL = ["tool_name", "tool_input.*", "mcp_server.*"];
/** Hook input fields per event. */
const EVENT_FIELDS: Record<string, string[] | undefined> = {
  PreToolUse: [...COMMON, ...TOOL, "tool_use_id"],
  PostToolUse: [
    ...COMMON,
    ...TOOL,
    "tool_use_id",
    "tool_response.*",
    "duration_ms",
  ],
  CwdChanged: [...COMMON, "old_cwd", "new_cwd"],
  // Claude Code 2.1.316: file_path is absolute, event is change|add|unlink
  FileChanged: [...COMMON, "file_path", "event"],
  SessionStart: [...COMMON, "source"],
  UserPromptSubmit: [...COMMON, "prompt"],
};
/** tool_input fields of the tools a matcher may name; matchers naming other tools allow any tool_input field. */
const TOOL_INPUT: Record<string, string[]> = {
  Write: ["file_path", "content"],
  Edit: ["file_path", "old_string", "new_string", "replace_all"],
};

/** A JSON object as read from disk; its fields are checked before use. */
type Json = Record<string, unknown>;

/** One hook of a matcher group in hooks.json. */
interface Hook {
  /** `mcp_tool` or `command`. */
  type?: unknown;
  /** Timeout in seconds. */
  timeout?: unknown;
  /** Shell command of a `command` hook. */
  command?: unknown;
  /** `plugin:<name>:<server>` of an `mcp_tool` hook. */
  server?: unknown;
  /** MCP tool name of an `mcp_tool` hook. */
  tool?: unknown;
  /** Argument template of an `mcp_tool` hook. */
  input?: unknown;
}

/** A matcher group in hooks.json. */
interface Group {
  /** Tool names joined by `|` or `,`. */
  matcher?: unknown;
  /** The group's hooks. */
  hooks?: unknown;
}

/** Validation errors, `<where>: <message>`. */
const errors: string[] = [];

/**
 * Record one validation error.
 *
 * @param where - Location in hooks.json.
 * @param msg - What is wrong.
 */
const fail = (where: string, msg: string): void => {
  errors.push(`${where}: ${msg}`);
};

/**
 * Read a JSON object file.
 *
 * @param file - Path to read.
 * @returns The parsed object.
 */
const readJson = (file: string): Json => JSON.parse(readFileSync(file, "utf8")) as Json;

/**
 * Whether a dotted field path is allowed.
 *
 * @param field - Dotted path, e.g. `tool_input.file_path`.
 * @param allowed - Allowed paths; `x.*` allows every `x.<sub>`.
 * @returns true when `field` is allowed.
 */
const allowedField = (field: string, allowed: string[]): boolean => allowed.some((a) => a.endsWith(".*") ? field.startsWith(a.slice(0, -1)) : field === a);

/**
 * TS type of one input template value; reports invalid `${…}` placeholders.
 *
 * @param value - Template value.
 * @param where - Location for errors.
 * @param fields - Input fields the placeholders may name.
 * @returns A primitive type name, or the nested object to render as members.
 */
function typeOf(value: unknown, where: string, fields: string[]): string | Json {
  if (typeof value === "string") {
    for (const [, p] of value.matchAll(/\$\{([^}]*)\}/g)) {
      if (!allowedField(p, fields)) {
        fail(where, `placeholder \${${p}} is not a field of this hook's input`);
      }
    }
    return "string";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return typeof value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  fail(where, `unsupported input value ${JSON.stringify(value)}`);
  return "unknown";
}

/**
 * Render an input template as TS interface members (every member optional: a call may come from elsewhere).
 *
 * @param input - Template object.
 * @param where - Location for errors.
 * @param fields - Input fields the placeholders may name.
 * @param indent - Indentation of the members.
 * @returns The rendered members.
 */
function members(input: Json, where: string, fields: string[], indent: string): string {
  return Object.entries(input)
    .map(([k, v]) => {
      if (!/^[A-Za-z_$][\w$]*$/.test(k)) {
        fail(`${where}.${k}`, "input key must be a valid identifier");
      }
      const t = typeOf(v, `${where}.${k}`, fields);
      const doc = typeof v === "string" ? `${indent}/** Template: \`${v}\`. */\n` : "";
      const body = typeof t === "string"
        ? t
        : `{\n${members(t, `${where}.${k}`, fields, indent + "  ")}\n${indent}}`;
      return `${doc}${indent}${k}?: ${body};`;
    })
    .join("\n");
}

/**
 * snake_case to PascalCase.
 *
 * @param s - snake_case name.
 * @returns The PascalCase name.
 */
const pascal = (s: string): string => s.replace(/(^|_)([a-z])/g, (_: string, __: string, c: string) => c.toUpperCase());

// --- validate ---
let hooks: Json, manifest: Json, mcp: Json;
try {
  hooks = readJson(HOOKS);
  manifest = readJson(path.join(ROOT, "plugin.json"));
  mcp = readJson(path.join(ROOT, "plugin/.mcp.json"));
} catch (e) {
  console.error(`hooks: ${(e as Error).message}`);
  process.exit(1);
}
/** Server keys of plugin/.mcp.json. */
const serverKeys = Object.keys((mcp.mcpServers as Json | undefined) ?? {});
/** Valid `server` values of `mcp_tool` hooks. */
const servers = new Set(serverKeys.map((k) => `plugin:${String(manifest.name)}:${k}`));
/** Per MCP tool: the first hook that calls it and its rendered input members. */
const tools = new Map<string, { event: string; matcher: unknown; rendered: string }>();

for (const [event, groups] of Object.entries((hooks.hooks as Json | undefined) ?? {})) {
  const fields = EVENT_FIELDS[event];
  if (!fields) {
    fail(
      event,
      "event not known to scripts/hooks.mts; add its input fields to EVENT_FIELDS",
    );
    continue;
  }
  if (!Array.isArray(groups)) {
    fail(event, "must be an array of matcher groups");
    continue;
  }
  (groups as Group[]).forEach((g, gi) => {
    // Claude Code accepts "|" and "," between tool names, with optional spaces
    const names = typeof g.matcher === "string"
      ? g.matcher.split(/[|,]/).map((n) => n.trim())
      : [];
    const known = names.length > 0 && names.every((n) => n in TOOL_INPUT);
    const groupFields = known
      ? [
        ...fields.filter((f) => f !== "tool_input.*"),
        ...names.flatMap((n) => TOOL_INPUT[n].map((f) => `tool_input.${f}`)),
      ]
      : fields;
    (Array.isArray(g.hooks) ? (g.hooks as Hook[]) : []).forEach((h, hi) => {
      const where = `${event}[${gi}].hooks[${hi}]`;
      if (
        h.timeout !== undefined
        && !(typeof h.timeout === "number" && Number.isInteger(h.timeout) && h.timeout > 0)
      ) {
        fail(where, "timeout must be a positive integer (seconds)");
      }
      // command hooks get the raw event on stdin: no server, tool, input or placeholders, so no generated types
      if (h.type === "command") {
        if (typeof h.command !== "string" || !h.command) {
          fail(where, "command must be a non-empty string");
        }
        return;
      }
      if (h.type !== "mcp_tool") {
        return fail(
          where,
          `type must be "mcp_tool" or "command" (got ${String(JSON.stringify(h.type))})`,
        );
      }
      if (typeof h.server !== "string" || !servers.has(h.server)) {
        fail(
          where,
          `server ${String(JSON.stringify(h.server))} must be one of ${[...servers].join(", ") || "(no .mcp.json servers)"}`,
        );
      }
      if (typeof h.tool !== "string" || !/^[a-z][a-z0-9_]*$/.test(h.tool)) {
        return fail(
          where,
          `tool must be a snake_case name (got ${String(JSON.stringify(h.tool))})`,
        );
      }
      if (!h.input || typeof h.input !== "object" || Array.isArray(h.input)) {
        return fail(
          where,
          "input must be an object (without it the tool gets the untyped full event)",
        );
      }
      const rendered = members(h.input as Json, `${where}.input`, groupFields, "  ");
      const prev = tools.get(h.tool);
      if (prev && prev.rendered !== rendered) {
        fail(
          where,
          `tool ${h.tool} is also called from ${prev.event} with a different input shape`,
        );
      }
      if (!prev) tools.set(h.tool, { event, matcher: g.matcher, rendered });
    });
    if (!Array.isArray(g.hooks)) {
      fail(`${event}[${gi}]`, "hooks must be an array");
    }
  });
}

if (errors.length) {
  console.error(
    `hooks: ${path.relative(process.cwd(), HOOKS)} is invalid:\n  ${errors.join("\n  ")}`,
  );
  process.exit(1);
}

// --- generate ---
/** One generated interface per tool. */
const blocks = [...tools].map(([tool, { event, matcher, rendered }]) => {
  const on = typeof matcher === "string" && matcher ? `${event} \`${matcher}\`` : event;
  return `/** Arguments of MCP tool \`${tool}\` (${on} hook). */\nexport interface ${pascal(tool)}Input {\n${rendered}\n}`;
});
/** Members of the generated `HookInputs` map. */
const map = [...tools.keys()]
  .map((t) => `  /** {@link ${pascal(t)}Input} */\n  ${t}: ${pascal(t)}Input;`)
  .join("\n");
/** The generated hook-inputs.d.mts. */
const text = `/**
 * Argument types of the MCP tools called by \`plugin/hooks/hooks.json\`.
 *
 * @remarks
 * Generated by \`scripts/hooks.mts\` from the hooks' \`input\` templates; do not edit. Regenerate with
 * \`pnpm build\` (or \`node scripts/hooks.mts\`); \`pnpm lint\` fails while this file is stale. Every
 * member is optional: Claude Code fills it from the template, but a tool can also be called directly.
 *
 * @packageDocumentation
 */

${blocks.join("\n\n")}

/** Tool name to argument type, for every tool \`hooks.json\` calls (the server must implement exactly these). */
export interface HookInputs {
${map}
}
`;

/** Whether the committed file differs from the generated one. */
const stale = !existsSync(OUT) || readFileSync(OUT, "utf8") !== text;
if (check) {
  if (stale) {
    console.error(
      `hooks: ${path.relative(process.cwd(), OUT)} is stale; run \`node scripts/hooks.mts\` (or pnpm build)`,
    );
    process.exit(1);
  }
} else if (stale) {
  writeFileSync(OUT, text);
  console.log(`hooks: wrote ${path.relative(process.cwd(), OUT)}`);
}
