// Port of the bats install.sh cases (init-dev-environment template). Hermetic: install.sh runs under an empty
// environment on a PATH of stub executables with an isolated HOME and TMPDIR; no real curl is ever on that PATH.
import { spawnSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expect, test } from "vitest";
import { makeStub, PLUGIN, put, tmpDir } from "./support/plugin.js";

const INSTALL = join(PLUGIN, "skills", "repository-audit", "templates", "init-dev-environment", "install.sh");

/** One isolated test environment. */
type Env = { tmp: string; bin: string; home: string };

/**
 * Resolves a host binary on the real PATH.
 *
 * @param name - Command name.
 * @returns Its absolute path, or undefined.
 */
function which(name: string): string | undefined {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(d, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch { /* next */ }
  }
  return undefined;
}

/**
 * Symlinks host binaries into the stub PATH.
 *
 * @param env - The test environment.
 * @param names - Command names.
 */
function linkTools(env: Env, ...names: string[]): void {
  for (const n of names) {
    const src = which(n);
    if (!src) continue;
    rmSync(join(env.bin, n), { force: true });
    symlinkSync(src, join(env.bin, n));
  }
}

/**
 * Creates the isolated environment: stub PATH with node, bash, cat, git; empty HOME.
 *
 * @returns The environment.
 */
function setup(): Env {
  const tmp = tmpDir("cck-inst-");
  const env = { tmp, bin: join(tmp, "bin"), home: join(tmp, "home") };
  mkdirSync(env.bin);
  mkdirSync(env.home);
  linkTools(env, "node", "bash", "cat", "git");
  return env;
}

/**
 * Runs an install.sh under an empty environment on the stub PATH.
 *
 * @param env - The test environment.
 * @param args - install.sh arguments.
 * @param script - Script path (default the shipped template).
 * @returns Exit status and combined stdout and stderr.
 */
function runInstall(env: Env, args: string[], script = INSTALL): { status: number | null; output: string } {
  const r = spawnSync(join(env.bin, "bash"), [script, ...args], {
    env: { PATH: env.bin, HOME: env.home, TMPDIR: env.tmp },
    encoding: "utf8",
  });
  return { status: r.status, output: r.stdout + r.stderr };
}

/**
 * Writes an executable file.
 *
 * @param path - Absolute path.
 * @param lines - Script body lines.
 */
function exe(path: string, lines: string[]): void {
  put(path, `#!/usr/bin/env bash\n${lines.join("\n")}\n`, 0o755);
}

/**
 * Like rustup's real ~/.cargo/bin/rust-analyzer proxy: the stub exits 1 until `$TMPDIR/ra.component` exists; plus a
 * cargo stub that exits 0.
 *
 * @param env - The test environment.
 */
function rustupProxyFixture(env: Env): void {
  const cb = join(env.home, ".cargo", "bin");
  exe(join(cb, "rust-analyzer"), [
    "if [ ! -e \"$TMPDIR/ra.component\" ]; then echo \"error: Unknown binary rust-analyzer in official toolchain\" >&2; exit 1; fi",
    "echo \"rust-analyzer 1.0.0\"",
  ]);
  exe(join(cb, "cargo"), ["exit 0"]);
}

/**
 * Reads a file of the test tmp dir.
 *
 * @param env - The test environment.
 * @param name - File name.
 * @returns The text.
 */
const readTmp = (env: Env, name: string): string => readFileSync(join(env.tmp, name), "utf8");

test("install.sh passes bash -n", () => {
  const r = spawnSync("bash", ["-n", INSTALL], { encoding: "utf8" });
  expect(r.status).toBe(0);
});

test("install.sh never uses sudo or touches shell rc files on a non-comment line", () => {
  const lines = readFileSync(INSTALL, "utf8").split("\n").filter((l) => !/^\s*#/.test(l));
  expect(lines.filter((l) => /sudo|\.bashrc|\.bash_profile|\.zshrc|\.profile/.test(l))).toEqual([]);
});

test("install.sh --dry-run reports present and missing tools and installs nothing", () => {
  const env = setup();
  const r = runInstall(env, ["--dry-run", "node", "pnpm"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("present: node");
  expect(r.output).toContain("missing: pnpm");
  expect(r.output).not.toContain("note:");
  expect(existsSync(join(env.home, ".local"))).toBe(false);
});

test("install.sh --dry-run dprint reports missing", () => {
  const env = setup();
  const r = runInstall(env, ["--dry-run", "dprint"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("missing: dprint");
  expect(existsSync(join(env.home, ".local"))).toBe(false);
});

test("install.sh --dry-run notes a present tool reachable only via the dirs it appended to PATH", () => {
  const env = setup();
  exe(join(env.home, ".local", "bin", "pnpm"), ["exit 0"]);
  const r = runInstall(env, ["--dry-run", "node", "pnpm"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("present: pnpm");
  expect(r.output).toMatch(/note: not on PATH.* pnpm;/s);
  expect(r.output).not.toContain(" node;");
});

test("install.sh honours --dry-run in any argument position and installs nothing", () => {
  const env = setup();
  linkTools(env, "mkdir");
  makeStub(env.bin, "npm", ["echo \"$*\" >> \"$TMPDIR/npm.args\""]);
  const r = runInstall(env, ["node", "pnpm", "--dry-run"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("present: node");
  expect(r.output).toContain("missing: pnpm");
  expect(r.output).not.toContain("unknown tool id");
  expect(existsSync(join(env.tmp, "npm.args"))).toBe(false);
  expect(existsSync(join(env.home, ".local"))).toBe(false);
});

test("install.sh: an unknown tool id prints FAILED (unknown tool id) and exits 1", () => {
  const env = setup();
  const r = runInstall(env, ["nope"]);
  expect(r.status).toBe(1);
  expect(r.output).toContain("FAILED: nope (unknown tool id)");
});

test("install.sh installs pnpm via npm --prefix ~/.local and prints the PATH note", () => {
  const env = setup();
  linkTools(env, "mkdir", "chmod");
  makeStub(env.bin, "npm", [
    "echo \"$*\" >> \"$TMPDIR/npm.args\"",
    "printf \"%s\\n\" \"#!/usr/bin/env bash\" > \"$HOME/.local/bin/pnpm\"",
    "chmod +x \"$HOME/.local/bin/pnpm\"",
  ]);
  const r = runInstall(env, ["pnpm"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("present: node");
  expect(r.output).toContain("installed: pnpm");
  expect(r.output).toContain("note:");
  expect(readTmp(env, "npm.args").split("\n")).toContain(`install -g --prefix ${env.home}/.local pnpm`);
});

test("install.sh prints FAILED and exits 1 when the pnpm recipe fails", () => {
  const env = setup();
  linkTools(env, "mkdir");
  makeStub(env.bin, "npm", ["exit 1"]);
  const r = runInstall(env, ["pnpm"]);
  expect(r.status).toBe(1);
  expect(r.output).toContain("FAILED: pnpm");
});

test("install.sh names npm when node is present without npm and the pnpm recipe cannot run", () => {
  const env = setup();
  linkTools(env, "mkdir");
  const r = runInstall(env, ["pnpm"]);
  expect(r.status).toBe(1);
  expect(r.output).toContain("present: node");
  expect(r.output).toContain("npm not found");
  expect(r.output).toContain("FAILED: pnpm");
});

test("install.sh --dry-run treats a bare rustup rust-analyzer proxy as missing (D21)", () => {
  const env = setup();
  rustupProxyFixture(env);
  const r = runInstall(env, ["--dry-run", "rust-analyzer"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("missing: rust-analyzer");
  expect(r.output).not.toContain("present: rust-analyzer");
  expect(existsSync(join(env.tmp, "rustup.args"))).toBe(false);
});

test("install.sh adds the rust-analyzer component over the rustup proxy, then dry-run agrees (D21)", () => {
  const env = setup();
  rustupProxyFixture(env);
  exe(join(env.home, ".cargo", "bin", "rustup"), ["echo \"$*\" >> \"$TMPDIR/rustup.args\"", ": > \"$TMPDIR/ra.component\""]);
  linkTools(env, "mkdir", "ln");
  const r = runInstall(env, ["rust-analyzer"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("present: cargo");
  expect(r.output).toContain("installed: rust-analyzer");
  expect(readTmp(env, "rustup.args").trim()).toBe("component add rust-analyzer");
  const link = join(env.home, ".local", "bin", "rust-analyzer");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(join(env.home, ".cargo", "bin", "rust-analyzer"));
  const d = runInstall(env, ["--dry-run", "rust-analyzer"]);
  expect(d.status).toBe(0);
  expect(d.output).toContain("present: rust-analyzer");
});

test("install.sh --dry-run treats a rustup cargo proxy without a toolchain as missing", () => {
  const env = setup();
  exe(join(env.home, ".cargo", "bin", "cargo"), ["echo \"error: rustup could not choose a version of cargo to run\" >&2", "exit 1"]);
  const r = runInstall(env, ["--dry-run", "cargo"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("missing: cargo");
  expect(r.output).not.toContain("present: cargo");
});

test("install.sh bootstraps rustup before the rust-analyzer component when only a distro cargo exists", () => {
  const env = setup();
  linkTools(env, "mkdir", "mktemp", "rm");
  makeStub(env.bin, "cargo", ["exit 0"]);
  makeStub(env.bin, "curl", ["echo \"$*\" >> \"$TMPDIR/curl.args\"", "exit 1"]);
  const r = runInstall(env, ["rust-analyzer"]);
  expect(r.status).toBe(1);
  expect(r.output).toContain("present: cargo");
  expect(r.output).toContain("FAILED: rust-analyzer");
  expect(readTmp(env, "curl.args")).toContain("https://sh.rustup.rs");
});

test("install.sh runs nothing and links nothing when the rustup download fails", () => {
  const env = setup();
  linkTools(env, "mkdir", "mktemp", "rm", "ln", "sh");
  makeStub(env.bin, "curl", ["exit 1"]);
  const r = runInstall(env, ["cargo"]);
  expect(r.status).toBe(1);
  expect(r.output).toContain("FAILED: cargo");
  expect(existsSync(join(env.home, ".local", "bin", "cargo"))).toBe(false);
});

test("install.sh installs uv by running the downloaded script with UV_INSTALL_DIR set", () => {
  const env = setup();
  linkTools(env, "mkdir", "mktemp", "rm", "chmod", "sh");
  put(join(env.tmp, "uv-install.sh"), "mkdir -p \"$UV_INSTALL_DIR\"\nprintf \"#!/usr/bin/env bash\\n\" > \"$UV_INSTALL_DIR/uv\"\nchmod +x \"$UV_INSTALL_DIR/uv\"\n");
  makeStub(env.bin, "curl", [
    "echo \"$*\" >> \"$TMPDIR/curl.args\"",
    "while [ $# -gt 0 ]; do [ \"$1\" = \"-o\" ] && out=$2; shift; done",
    "cat \"$TMPDIR/uv-install.sh\" > \"$out\"",
  ]);
  const r = runInstall(env, ["uv"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("installed: uv");
  expect(readTmp(env, "curl.args")).toContain("https://astral.sh/uv/install.sh");
  expect(() => accessSync(join(env.home, ".local", "bin", "uv"), constants.X_OK)).not.toThrow();
});

test("install.sh installs yarn as a corepack shim in ~/.local/bin, not Classic via npm", () => {
  const env = setup();
  linkTools(env, "mkdir", "chmod");
  makeStub(env.bin, "npm", ["echo \"$*\" >> \"$TMPDIR/npm.args\""]);
  makeStub(env.bin, "corepack", [
    "echo \"$*\" >> \"$TMPDIR/corepack.args\"",
    "printf \"%s\\n\" \"#!/usr/bin/env bash\" > \"$HOME/.local/bin/yarn\"",
    "chmod +x \"$HOME/.local/bin/yarn\"",
  ]);
  const r = runInstall(env, ["yarn"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("installed: yarn");
  expect(readTmp(env, "corepack.args").trim()).toBe(`enable --install-directory ${env.home}/.local/bin yarn`);
  expect(existsSync(join(env.tmp, "npm.args"))).toBe(false);
});

test("install.sh fetches corepack through npm when it is missing, then enables the yarn shim", () => {
  const env = setup();
  linkTools(env, "mkdir", "chmod");
  put(
    join(env.tmp, "corepack.sh"),
    "#!/usr/bin/env bash\necho \"$*\" >> \"$TMPDIR/corepack.args\"\nprintf \"#!/usr/bin/env bash\\n\" > \"$HOME/.local/bin/yarn\"\nchmod +x \"$HOME/.local/bin/yarn\"\n",
  );
  makeStub(env.bin, "npm", [
    "echo \"$*\" >> \"$TMPDIR/npm.args\"",
    "cat \"$TMPDIR/corepack.sh\" > \"$HOME/.local/bin/corepack\"",
    "chmod +x \"$HOME/.local/bin/corepack\"",
  ]);
  const r = runInstall(env, ["yarn"]);
  expect(r.status).toBe(0);
  expect(r.output).toContain("installed: yarn");
  expect(readTmp(env, "npm.args").trim()).toBe(`install -g --prefix ${env.home}/.local corepack`);
  expect(readTmp(env, "corepack.args").trim()).toBe(`enable --install-directory ${env.home}/.local/bin yarn`);
});

test("install.sh node honours a numeric .nvmrc pin, falls back to the newest LTS, and fails on an unmatched pin", () => {
  const env = setup();
  const proj = join(env.tmp, "p_node");
  const d = join(proj, ".claude", "skills", "init-dev-environment");
  mkdirSync(d, { recursive: true });
  copyFileSync(INSTALL, join(d, "install.sh"));
  const rows = [["v22.5.0", "-"], ["v20.11.1", "Iron"], ["v18.19.1", "Hydrogen"], ["v18.19.0", "Hydrogen"]];
  put(
    join(env.tmp, "index.tab"),
    "version\tdate\tfiles\tnpm\tv8\tuv\tzlib\topenssl\tmodules\tlts\tsecurity\n"
      + rows.map(([v, l]) => `${v}\t2024-01-01\tf\tn\tv\tu\tz\to\tm\t${l}\t-\n`).join(""),
  );
  linkTools(env, "mkdir", "uname", "tr", "awk", "mktemp", "rm", "dirname");
  rmSync(join(env.bin, "node"), { force: true });
  makeStub(env.bin, "curl", ["case \"$*\" in *index.tab*) cat \"$TMPDIR/index.tab\" ;; *) echo \"$*\" >> \"$TMPDIR/curl.args\"; exit 1 ;; esac"]);
  const script = join(d, "install.sh");
  const curlArgs = join(env.tmp, "curl.args");

  put(join(proj, ".nvmrc"), "v18\n");
  let r = runInstall(env, ["node"], script);
  expect(r.status).toBe(1);
  expect(readFileSync(curlArgs, "utf8")).toContain("https://nodejs.org/dist/v18.19.1/node-v18.19.1-");
  rmSync(curlArgs, { force: true });

  put(join(proj, ".nvmrc"), "lts/*\n");
  r = runInstall(env, ["node"], script);
  expect(r.status).toBe(1);
  expect(readFileSync(curlArgs, "utf8")).toContain("https://nodejs.org/dist/v20.11.1/node-v20.11.1-");
  rmSync(curlArgs, { force: true });

  put(join(proj, ".nvmrc"), "99\n");
  r = runInstall(env, ["node"], script);
  expect(r.status).toBe(1);
  expect(r.output).toContain("no Node release matches the project's pin: 99");
  expect(r.output).toContain("FAILED: node");
  expect(existsSync(curlArgs)).toBe(false);
});
