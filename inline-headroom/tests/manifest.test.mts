// Manifest and wiring contract of the built plugin/ (ported from claude-plugins' test/inline-headroom/test.bats).
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "vitest";

/** Parsed JSON of a file under plugin/. */
const json = (rel: string) => JSON.parse(readFileSync(new URL(`../plugin/${rel}`, import.meta.url), "utf8"));
const manifest = json(".claude-plugin/plugin.json");

test("the manifest has name, author Kwitsch, a non-empty description and string keywords", () => {
  assert.equal(manifest.name, "inline-headroom");
  assert.equal(manifest.author.name, "Kwitsch");
  assert.ok(manifest.description.length > 0);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
  for (const k of manifest.keywords) assert.equal(typeof k, "string");
});

test("userConfig declares exactly the seventeen boolean feature toggles, all default true", () => {
  assert.deepEqual(Object.keys(manifest.userConfig).sort(), [
    "cache_aligner_enabled",
    "config_compressor_enabled",
    "cross_turn_dedup_enabled",
    "dense_line_elider_enabled",
    "diff_compressor_enabled",
    "effort_routing_enabled",
    "html_extractor_enabled",
    "log_compressor_enabled",
    "lossless_compaction_enabled",
    "relevance_split_enabled",
    "search_compressor_enabled",
    "smart_crusher_enabled",
    "storage_enabled",
    "subagent_compression_enabled",
    "subagent_effort_routing_enabled",
    "tag_protector_enabled",
    "text_crusher_enabled",
  ]);
  for (const [k, v] of Object.entries(manifest.userConfig as Record<string, { type: string; default: unknown; title: string; description: string }>)) {
    assert.ok(v.type === "boolean" && v.default === true && v.title.length > 0 && v.description.length > 0, k);
  }
});

test(".mcp.json registers the storage server directly with the fail-closed toggle env", () => {
  assert.deepEqual(json(".mcp.json"), {
    mcpServers: {
      storage: {
        command: "${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs",
        env: { INLINE_HEADROOM_STORAGE_ENABLED: "${user_config.storage_enabled}" },
      },
    },
  });
});

test("mcp/server.mjs is an executable node program", () => {
  const server = new URL("../plugin/mcp/server.mjs", import.meta.url);
  assert.ok(statSync(server).mode & 0o111);
  assert.equal(readFileSync(server, "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("hooks.json is exactly the mods module list, and the built modules exist", () => {
  assert.deepEqual(json("hooks/hooks.json"), { modules: ["./register.mjs"] });
  for (const f of ["hooks/register.mjs", "hooks/policy.mjs"]) {
    assert.ok(existsSync(new URL(`../plugin/${f}`, import.meta.url)), f);
  }
});
