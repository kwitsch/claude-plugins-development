#!/usr/bin/env node
// Validate plugin/hooks/hooks.json and generate src/mcp/hook-inputs.d.mts (the argument types of every MCP
// tool the hooks call) from its `input` templates. hooks.json is the contract: Claude Code builds each tool
// call's arguments from those templates, so the types are derived from it, never written by hand.
//
//   node scripts/hooks.mjs [root]          validate, then (re)write the types
//   node scripts/hooks.mjs --check [root]  validate and fail when the committed types are stale (lint/CI)
//
// root defaults to the plugin dir (the parent of scripts/); tests pass a scratch copy.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const check = args[0] === "--check";
const ROOT = path.resolve(
  (check ? args[1] : args[0]) ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const HOOKS = path.join(ROOT, "plugin/hooks/hooks.json");
const OUT = path.join(ROOT, "src/mcp/hook-inputs.d.mts");

// Hook input fields per event (cc-reference hooks reference, "Input"). `*` = any sub-path.
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
const TOOL = ["tool_name", "tool_input.*", "mcp_server.*"];
const EVENT_FIELDS = {
  PreToolUse: [...COMMON, ...TOOL, "tool_use_id"],
  PostToolUse: [
    ...COMMON,
    ...TOOL,
    "tool_use_id",
    "tool_response.*",
    "duration_ms",
  ],
  CwdChanged: [...COMMON, "old_cwd", "new_cwd"],
};
// tool_input fields of the tools a matcher may name; matchers naming other tools allow any tool_input field
const TOOL_INPUT = {
  Write: ["file_path", "content"],
  Edit: ["file_path", "old_string", "new_string", "replace_all"],
};

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** true when `field` (dotted path) is allowed by the `allowed` list (`x.*` allows every `x.<sub>`). */
const allowedField = (field, allowed) =>
  allowed.some((a) =>
    a.endsWith(".*") ? field.startsWith(a.slice(0, -1)) : field === a,
  );

/** TS type of one input template value; reports invalid `${…}` placeholders. */
function typeOf(value, where, fields) {
  if (typeof value === "string") {
    for (const [, p] of value.matchAll(/\$\{([^}]*)\}/g))
      if (!allowedField(p, fields))
        fail(where, `placeholder \${${p}} is not a field of this hook's input`);
    return "string";
  }
  if (typeof value === "number" || typeof value === "boolean")
    return typeof value;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  fail(where, `unsupported input value ${JSON.stringify(value)}`);
  return "unknown";
}

/** Render an input template as TS interface members (every member optional: a call may come from elsewhere). */
function members(input, where, fields, indent) {
  return Object.entries(input)
    .map(([k, v]) => {
      if (!/^[A-Za-z_$][\w$]*$/.test(k))
        fail(`${where}.${k}`, "input key must be a valid identifier");
      const t = typeOf(v, `${where}.${k}`, fields);
      const doc =
        typeof v === "string" ? `${indent}/** Template: \`${v}\`. */\n` : "";
      const body =
        typeof t === "string"
          ? t
          : `{\n${members(t, `${where}.${k}`, fields, indent + "  ")}\n${indent}}`;
      return `${doc}${indent}${k}?: ${body};`;
    })
    .join("\n");
}

const pascal = (s) => s.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());

// --- validate ---
let hooks, manifest, mcp;
try {
  hooks = readJson(HOOKS);
  manifest = readJson(path.join(ROOT, "plugin.json"));
  mcp = readJson(path.join(ROOT, "plugin/.mcp.json"));
} catch (e) {
  console.error(`hooks: ${e.message}`);
  process.exit(1);
}
const serverKeys = Object.keys(mcp.mcpServers ?? {});
const servers = new Set(serverKeys.map((k) => `plugin:${manifest.name}:${k}`));
const tools = new Map(); // tool -> { event, matcher, rendered }

for (const [event, groups] of Object.entries(hooks.hooks ?? {})) {
  const fields = EVENT_FIELDS[event];
  if (!fields) {
    fail(
      event,
      "event not known to scripts/hooks.mjs; add its input fields to EVENT_FIELDS",
    );
    continue;
  }
  if (!Array.isArray(groups)) {
    fail(event, "must be an array of matcher groups");
    continue;
  }
  groups.forEach((g, gi) => {
    // Claude Code accepts "|" and "," between tool names, with optional spaces
    const names =
      typeof g.matcher === "string"
        ? g.matcher.split(/[|,]/).map((n) => n.trim())
        : [];
    const known = names.length > 0 && names.every((n) => n in TOOL_INPUT);
    const groupFields = known
      ? [
          ...fields.filter((f) => f !== "tool_input.*"),
          ...names.flatMap((n) => TOOL_INPUT[n].map((f) => `tool_input.${f}`)),
        ]
      : fields;
    (Array.isArray(g.hooks) ? g.hooks : []).forEach((h, hi) => {
      const where = `${event}[${gi}].hooks[${hi}]`;
      if (h.type !== "mcp_tool")
        return fail(
          where,
          `type must be "mcp_tool" (got ${JSON.stringify(h.type)})`,
        );
      if (!servers.has(h.server))
        fail(
          where,
          `server ${JSON.stringify(h.server)} must be one of ${[...servers].join(", ") || "(no .mcp.json servers)"}`,
        );
      if (typeof h.tool !== "string" || !/^[a-z][a-z0-9_]*$/.test(h.tool))
        return fail(
          where,
          `tool must be a snake_case name (got ${JSON.stringify(h.tool)})`,
        );
      if (
        h.timeout !== undefined &&
        !(Number.isInteger(h.timeout) && h.timeout > 0)
      )
        fail(where, "timeout must be a positive integer (seconds)");
      if (!h.input || typeof h.input !== "object" || Array.isArray(h.input))
        return fail(
          where,
          "input must be an object (without it the tool gets the untyped full event)",
        );
      const rendered = members(h.input, `${where}.input`, groupFields, "  ");
      const prev = tools.get(h.tool);
      if (prev && prev.rendered !== rendered)
        fail(
          where,
          `tool ${h.tool} is also called from ${prev.event} with a different input shape`,
        );
      if (!prev) tools.set(h.tool, { event, matcher: g.matcher, rendered });
    });
    if (!Array.isArray(g.hooks))
      fail(`${event}[${gi}]`, "hooks must be an array");
  });
}

if (errors.length) {
  console.error(
    `hooks: ${path.relative(process.cwd(), HOOKS)} is invalid:\n  ${errors.join("\n  ")}`,
  );
  process.exit(1);
}

// --- generate ---
const blocks = [...tools].map(([tool, { event, matcher, rendered }]) => {
  const on = matcher ? `${event} \`${matcher}\`` : event;
  return `/** Arguments of MCP tool \`${tool}\` (${on} hook). */\nexport interface ${pascal(tool)}Input {\n${rendered}\n}`;
});
const map = [...tools.keys()]
  .map((t) => `  /** {@link ${pascal(t)}Input} */\n  ${t}: ${pascal(t)}Input;`)
  .join("\n");
const text = `/**
 * Argument types of the MCP tools called by \`plugin/hooks/hooks.json\`.
 *
 * @remarks
 * Generated by \`scripts/hooks.mjs\` from the hooks' \`input\` templates; do not edit. Regenerate with
 * \`pnpm build\` (or \`node scripts/hooks.mjs\`); \`pnpm lint\` fails while this file is stale. Every
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

const stale = !existsSync(OUT) || readFileSync(OUT, "utf8") !== text;
if (check) {
  if (stale) {
    console.error(
      `hooks: ${path.relative(process.cwd(), OUT)} is stale; run \`node scripts/hooks.mjs\` (or pnpm build)`,
    );
    process.exit(1);
  }
} else if (stale) {
  writeFileSync(OUT, text);
  console.log(`hooks: wrote ${path.relative(process.cwd(), OUT)}`);
}
