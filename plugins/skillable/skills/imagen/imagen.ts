#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VERSION = "1.0.0";
const PROTOCOL_VERSION = "1";

const MODEL = "gpt-image-2";
const MODERATION = "low";
const DEFAULT_QUALITY = "high";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_OUTPUT_FORMAT = "png";

const ALLOWED_QUALITIES = ["low", "medium", "high", "auto"] as const;
const ALLOWED_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const ALLOWED_REF_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_REF_BYTES = 50 * 1024 * 1024;

const STATE_DIR = `${homedir()}/.cache/imagen`;
const CONFIG_DIR = `${homedir()}/.config/imagen`;
const PROFILES_PATH = `${CONFIG_DIR}/profiles.json`;

type Quality = (typeof ALLOWED_QUALITIES)[number];
type OutputFormat = (typeof ALLOWED_OUTPUT_FORMATS)[number];

// Exit codes (shared library convention):
//   0 success
//   2 invocation error  (bad flag, missing arg, validation)
//   3 upstream error    (API failure, network, 5xx)
//   4 config error      (missing key, unverified org, unauthorized)
//   5 state error       (corrupt cache, missing source file)
const EXIT = { OK: 0, INVOCATION: 2, UPSTREAM: 3, CONFIG: 4, STATE: 5 } as const;

// ---------- arg parser ----------

type FlagType = "bool" | "string" | "string[]" | "number";
const FLAGS: Record<string, FlagType> = {
  "yes": "bool",
  "dry-run": "bool",
  "help": "bool",
  "version": "bool",
  "size": "string",
  "quality": "string",
  "out": "string",
  "profile": "string",
  "from": "string",
  "style": "string",
  "output-format": "string",
  "output-compression": "number",
  "limit": "number",
  "notes": "string",
  "ref": "string[]",
};
const SHORT: Record<string, string> = { h: "help", V: "version" };

interface ParsedArgs {
  subcommand: string[];
  positional: string[];
  flags: Record<string, string | string[] | boolean | number>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const subcommand: string[] = [];
  const positional: string[] = [];
  const flags: Record<string, string | string[] | boolean | number> = {};

  const ROOTS = new Set([
    "generate", "gen", "edit", "refs", "profile", "history",
    "reset", "setup", "describe", "help",
  ]);
  const TWO_LEVEL = new Set(["refs", "profile"]);

  let i = 0;
  if (i < argv.length && ROOTS.has(argv[i]!)) {
    subcommand.push(argv[i++]!);
    if (TWO_LEVEL.has(subcommand[0]!) && i < argv.length && !argv[i]!.startsWith("-")) {
      subcommand.push(argv[i++]!);
    }
  }

  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let name: string;
      let inlineValue: string | undefined;
      if (eq !== -1) {
        name = a.slice(2, eq);
        inlineValue = a.slice(eq + 1);
      } else {
        name = a.slice(2);
      }
      if (name.startsWith("no-")) {
        flags[name.slice(3)] = false;
        i++;
        continue;
      }
      const type = FLAGS[name];
      if (!type) {
        const known = Object.keys(FLAGS).map((k) => `--${k}`).sort().join(", ");
        fail(EXIT.INVOCATION, `unknown flag: --${name}`, `known flags: ${known}`);
      }
      if (type === "bool") {
        flags[name] = inlineValue === undefined ? true : /^(true|1|yes)$/i.test(inlineValue);
        i++;
        continue;
      }
      let v: string | undefined = inlineValue;
      if (v === undefined) {
        v = argv[i + 1];
        if (v === undefined) fail(EXIT.INVOCATION, `--${name} requires a value`);
        i += 2;
      } else {
        i++;
      }
      if (type === "string[]") {
        const cur = flags[name];
        if (Array.isArray(cur)) cur.push(v);
        else flags[name] = [v];
      } else if (type === "number") {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n)) fail(EXIT.INVOCATION, `--${name} must be a number, got: ${v}`);
        flags[name] = n;
      } else {
        flags[name] = v;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const short = a.slice(1);
      const long = SHORT[short];
      if (!long) fail(EXIT.INVOCATION, `unknown short flag: -${short}`, `known short flags: -h, -V`);
      flags[long] = true;
      i++;
    } else {
      positional.push(a);
      i++;
    }
  }
  return { subcommand, positional, flags };
}

function flagBool(p: ParsedArgs, name: string): boolean {
  return p.flags[name] === true;
}
function flagString(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}
function flagNum(p: ParsedArgs, name: string, dflt: number): number {
  const v = p.flags[name];
  return typeof v === "number" ? v : dflt;
}
function flagArr(p: ParsedArgs, name: string): string[] {
  const v = p.flags[name];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

function validateChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    fail(EXIT.INVOCATION, `--${flag} must be one of: ${allowed.join(", ")}`, `got: ${value}`);
  }
  return value as T;
}

// ---------- output ----------

function out(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

interface FailOptions {
  requires_tty?: boolean;
}

function fail(code: number, error: string, hint?: string, opts?: FailOptions): never {
  const payload: Record<string, unknown> = { ok: false, error };
  if (hint) payload.hint = hint;
  if (opts?.requires_tty) payload.requires_tty = true;
  out(payload);
  process.exit(code);
}

function nowIso(): string {
  return new Date().toISOString().slice(0, 19);
}

function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

function expandPath(p: string): string {
  if (p.startsWith("~")) return resolve(homedir() + p.slice(1));
  return resolve(p);
}

function guessMime(path: string): string | null {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return null;
}

function extForFormat(fmt: OutputFormat): string {
  return fmt === "jpeg" ? "jpg" : fmt;
}

// gpt-image-2 sometimes returns a different format than requested
// (notably ignores webp on the edit endpoint). Trust the bytes, not the flag.
function detectImageFormat(buf: Buffer): OutputFormat {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "webp";
  return "png";
}

// ---------- skill dir / .env ----------

const SKILL_DIR: string = import.meta.dir;
const ENV_FILE: string = `${SKILL_DIR}/.env`;

function loadEnvFile(): void {
  if (!existsSync(ENV_FILE)) return;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

// ---------- session state ----------

interface RefEntry {
  id: string;
  path: string;
  mime: string;
  bytes: number;
  added: string;
}

interface HistoryEntry {
  ts: string;
  command: "generate" | "edit";
  prompt: string;
  path: string;
  source: string | null;
  size: string;
  quality: Quality;
  output_format: OutputFormat;
  refs: string[];
  bytes: number;
}

interface SessionState {
  cwd: string;
  counter: number;
  last_image?: string;
  refs: RefEntry[];
  history: HistoryEntry[];
}

interface Profile {
  name: string;
  size?: string;
  quality?: Quality;
  output_format?: OutputFormat;
  output_compression?: number;
  style?: string;
  refs?: string[];
  notes?: string;
}

interface ProfilesFile {
  profiles: Record<string, Profile>;
}

function statePathForCwd(): string {
  const cwd = resolve(process.cwd());
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return `${STATE_DIR}/${hash}.json`;
}

function loadState(): SessionState {
  const p = statePathForCwd();
  if (!existsSync(p)) {
    return { cwd: resolve(process.cwd()), counter: 0, refs: [], history: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<SessionState>;
    return {
      cwd: raw.cwd ?? resolve(process.cwd()),
      counter: raw.counter ?? 0,
      last_image: raw.last_image,
      refs: raw.refs ?? [],
      history: raw.history ?? [],
    };
  } catch {
    fail(EXIT.STATE, `corrupt state at ${p}`, `delete the file and retry`);
  }
}

function saveState(state: SessionState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  if (state.history.length > 50) state.history = state.history.slice(-50);
  writeFileSync(statePathForCwd(), JSON.stringify(state, null, 2));
}

function nextOutputPath(state: SessionState, explicit: string | undefined, ext: string): string {
  if (explicit) {
    const p = expandPath(explicit);
    mkdirSync(dirname(p), { recursive: true });
    return p;
  }
  let n = (state.counter ?? 0) + 1;
  while (true) {
    const candidate = resolve(process.cwd(), `image-${String(n).padStart(3, "0")}.${ext}`);
    if (!existsSync(candidate)) return candidate;
    n += 1;
  }
}

// ---------- refs ----------

function resolveRef(state: SessionState, idOrPath: string): RefEntry {
  const byId = state.refs.find((r) => r.id === idOrPath);
  if (byId) {
    if (!existsSync(byId.path)) {
      fail(EXIT.STATE, `ref ${byId.id} points to a missing file: ${byId.path}`,
        `re-add it with: imagen refs add <new-path>`);
    }
    return byId;
  }
  const p = expandPath(idOrPath);
  if (!existsSync(p)) {
    fail(EXIT.INVOCATION, `not a known ref id and not a file path: ${idOrPath}`,
      `list registered refs: imagen refs list`);
  }
  const mime = guessMime(p);
  if (!mime || !ALLOWED_REF_MIME.has(mime)) {
    fail(EXIT.INVOCATION, `path is not a supported image type: ${p} (${mime ?? "unknown"})`,
      `allowed extensions: .png, .jpg, .jpeg, .webp`);
  }
  return { id: `path:${p}`, path: p, mime, bytes: statSync(p).size, added: nowIso() };
}

// ---------- profiles ----------

function loadProfiles(): ProfilesFile {
  if (!existsSync(PROFILES_PATH)) return { profiles: {} };
  try {
    return JSON.parse(readFileSync(PROFILES_PATH, "utf8")) as ProfilesFile;
  } catch {
    fail(EXIT.STATE, `corrupt profiles at ${PROFILES_PATH}`, `delete the file and retry`);
  }
}

function saveProfiles(file: ProfilesFile): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PROFILES_PATH, JSON.stringify(file, null, 2));
}

interface ProfileBase {
  size?: string;
  quality?: Quality;
  outputFormat?: OutputFormat;
  outputCompression?: number;
  style?: string;
  ref?: string[];
}

function applyProfile(base: ProfileBase, profileName: string | undefined): ProfileBase {
  if (!profileName) return base;
  const file = loadProfiles();
  const p = file.profiles[profileName];
  if (!p) {
    const known = Object.keys(file.profiles);
    fail(EXIT.INVOCATION, `unknown profile: ${profileName}`,
      known.length
        ? `available profiles: ${known.join(", ")}`
        : `no profiles saved yet — create one with: imagen profile save <name> [--size ...] [--quality ...]`);
  }
  return {
    size: base.size ?? p.size,
    quality: base.quality ?? p.quality,
    outputFormat: base.outputFormat ?? p.output_format,
    outputCompression: base.outputCompression ?? p.output_compression,
    style: base.style ?? p.style,
    ref: base.ref ?? p.refs,
  };
}

// ---------- TTY (setup only) ----------

function readSecretFromTTY(): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolvePromise) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch: string) => {
      const code = ch.charCodeAt(0);
      if (code === 13 || code === 10) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolvePromise(buf);
      } else if (code === 3) {
        stdin.setRawMode(false);
        stdin.pause();
        process.stderr.write("\n");
        process.exit(130);
      } else if (code === 127 || code === 8) {
        buf = buf.slice(0, -1);
      } else if (code >= 32) {
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// ---------- openai CLI shell-out ----------

function ensureOpenAICli(): void {
  const r = spawnSync("openai", ["--version"], { stdio: "ignore" });
  if (r.error || (r.status !== 0 && r.status !== null)) {
    fail(EXIT.CONFIG, "`openai` CLI not found on PATH",
      "install with: brew install openai-cli  (or: pip install openai-cli — see https://github.com/openai/openai-cli)");
  }
}

function classifyOpenAIError(stderr: string): { code: number; hint?: string } {
  if (/verification|must be verified/i.test(stderr)) {
    return { code: EXIT.CONFIG, hint: "complete one-time org verification at https://platform.openai.com/settings/organization/general" };
  }
  if (/401|Unauthorized|Missing bearer/i.test(stderr)) {
    return { code: EXIT.CONFIG, hint: "OPENAI_API_KEY missing or invalid — run `imagen setup`" };
  }
  if (/rate limit|429/i.test(stderr)) {
    return { code: EXIT.UPSTREAM, hint: "rate limited — try again in a moment" };
  }
  if (/safety system|content[_ ]policy|moderation_blocked|blocked by/i.test(stderr)) {
    return { code: EXIT.UPSTREAM, hint: "the prompt was blocked by moderation — try a softer rephrasing" };
  }
  return { code: EXIT.UPSTREAM };
}

interface OpenAIImageResponse {
  data?: Array<{ b64_json?: string; revised_prompt?: string }>;
  created?: number;
}

function callOpenAI(args: string[]): OpenAIImageResponse {
  // Explicit env: Bun's spawnSync snapshots process.env at startup and
  // won't see mutations from loadEnvFile() unless we pass it through.
  const r = spawnSync("openai", ["--format", "json", ...args], {
    encoding: "buffer",
    maxBuffer: 200 * 1024 * 1024,
    env: process.env as NodeJS.ProcessEnv,
  });
  if (r.error) throw new Error(`failed to spawn openai: ${r.error.message}`);
  if (r.status !== 0) {
    const stderr = r.stderr.toString("utf8");
    const stdout = r.stdout.toString("utf8");
    throw new Error(stderr.trim() || stdout.trim() || `openai exited with code ${r.status}`);
  }
  const stdout = r.stdout.toString("utf8");
  try {
    return JSON.parse(stdout) as OpenAIImageResponse;
  } catch {
    throw new Error(`openai returned non-JSON stdout (first 200 chars): ${stdout.slice(0, 200)}`);
  }
}

// ---------- core: generate / edit ----------

interface GenOptions {
  prompt: string;
  command: "generate" | "edit";
  source: string | null;
  refs: RefEntry[];
  size: string;
  quality: Quality;
  outputFormat: OutputFormat;
  outputCompression?: number;
  style?: string;
  outPath: string | undefined;
  dryRun: boolean;
}

function composePrompt(prompt: string, style: string | undefined): string {
  if (!style) return prompt;
  return `${style}, ${prompt}`;
}

async function runGeneration(opts: GenOptions): Promise<number> {
  const finalPrompt = composePrompt(opts.prompt.trim(), opts.style?.trim());
  if (!finalPrompt) fail(EXIT.INVOCATION, "prompt is required (non-empty)");

  const cliArgs: string[] = opts.command === "generate" ? ["images", "generate"] : ["images", "edit"];
  cliArgs.push("--model", MODEL);
  cliArgs.push("--prompt", finalPrompt);
  cliArgs.push("--size", opts.size);
  cliArgs.push("--quality", opts.quality);
  // `images edit` doesn't accept --moderation; only generate does.
  if (opts.command === "generate") cliArgs.push("--moderation", MODERATION);
  cliArgs.push("--output-format", opts.outputFormat);
  if (opts.outputCompression !== undefined && opts.outputFormat !== "png") {
    cliArgs.push("--output-compression", String(opts.outputCompression));
  }

  if (opts.command === "edit") {
    if (!opts.source) {
      fail(EXIT.INVOCATION, "edit requires a source image (last generated, --from, or a ref)",
        "use `imagen generate <prompt>` first, or pass --from <path>");
    }
    cliArgs.push("--image", opts.source);
    for (const r of opts.refs) cliArgs.push("--image", r.path);
  } else if (opts.refs.length > 0) {
    // generate with refs is rerouted through the edit endpoint, with the
    // first ref as the source image and any remaining refs as extras.
    const source = opts.refs[0]!.path;
    const extra = opts.refs.slice(1);
    return runGeneration({ ...opts, command: "edit", source, refs: extra });
  }

  if (opts.dryRun) {
    out({
      ok: true,
      dry_run: true,
      command: opts.command,
      model: MODEL,
      size: opts.size,
      quality: opts.quality,
      output_format: opts.outputFormat,
      prompt: finalPrompt,
      source: opts.source,
      refs: opts.refs.map((r) => ({ id: r.id, path: r.path, bytes: r.bytes })),
      would_invoke: ["openai", "--format", "json", ...cliArgs].join(" "),
    });
    return EXIT.OK;
  }

  ensureOpenAICli();

  let resp: OpenAIImageResponse;
  try {
    resp = callOpenAI(cliArgs);
  } catch (e) {
    const msg = (e as Error).message;
    const cls = classifyOpenAIError(msg);
    fail(cls.code, `openai CLI error: ${msg}`, cls.hint);
  }

  const first = resp.data?.[0];
  const imgB64 = first?.b64_json;
  const revisedPrompt = first?.revised_prompt ?? null;

  if (!imgB64) {
    fail(EXIT.UPSTREAM, "no image returned by openai CLI",
      `raw response keys: ${Object.keys(resp).join(", ")}`);
  }

  const buf = Buffer.from(imgB64, "base64");
  const actualFormat = detectImageFormat(buf);
  const state = loadState();
  const ext = extForFormat(actualFormat);
  const finalPath = nextOutputPath(state, opts.outPath, ext);
  writeFileSync(finalPath, buf);

  state.last_image = finalPath;
  state.counter = (state.counter ?? 0) + 1;
  state.history.push({
    ts: nowIso(),
    command: opts.command,
    prompt: finalPrompt,
    path: finalPath,
    source: opts.source,
    size: opts.size,
    quality: opts.quality,
    output_format: actualFormat,
    refs: opts.refs.map((r) => r.id),
    bytes: buf.length,
  });
  saveState(state);

  out({
    ok: true,
    command: opts.command,
    path: finalPath,
    source: opts.source,
    size: opts.size,
    quality: opts.quality,
    output_format: actualFormat,
    requested_output_format: opts.outputFormat !== actualFormat ? opts.outputFormat : undefined,
    refs: opts.refs.map((r) => r.id),
    bytes: buf.length,
    revised_prompt: revisedPrompt,
  });
  return EXIT.OK;
}

// ---------- subcommand handlers ----------

async function setupCommand(): Promise<number> {
  if (!process.stdin.isTTY) {
    fail(
      EXIT.CONFIG,
      "setup requires an interactive terminal (TTY)",
      `run this in your terminal: imagen setup\n` +
        `or write the file manually: echo 'OPENAI_API_KEY=sk-...' > ${ENV_FILE} && chmod 600 ${ENV_FILE}`,
      { requires_tty: true },
    );
  }
  if (existsSync(ENV_FILE)) {
    process.stderr.write(`A key already exists at ${ENV_FILE}.\nOverwrite? [y/N] `);
    const ans = await readSecretFromTTY();
    if (!/^y/i.test(ans.trim())) {
      out({ ok: true, aborted: true });
      return EXIT.OK;
    }
  }
  process.stderr.write("Paste your OpenAI API key (input hidden):\n");
  process.stderr.write("Get one at https://platform.openai.com/api-keys\n> ");
  const key = (await readSecretFromTTY()).trim();
  if (!key) fail(EXIT.INVOCATION, "no key provided");
  if (!key.startsWith("sk-")) fail(EXIT.INVOCATION, "that doesn't look like an OpenAI key (expected sk- prefix)");
  writeFileSync(ENV_FILE, `OPENAI_API_KEY=${key}\n`);
  chmodSync(ENV_FILE, 0o600);
  out({ ok: true, env_file: ENV_FILE, mode: "0600" });
  return EXIT.OK;
}

function refsAdd(path: string): number {
  const p = expandPath(path);
  if (!existsSync(p)) fail(EXIT.INVOCATION, `file not found: ${p}`);
  const mime = guessMime(p);
  if (!mime || !ALLOWED_REF_MIME.has(mime)) {
    fail(EXIT.INVOCATION, `not a supported image type: ${p} (${mime ?? "unknown"})`,
      `allowed extensions: .png, .jpg, .jpeg, .webp`);
  }
  const bytes = statSync(p).size;
  if (bytes > MAX_REF_BYTES) fail(EXIT.INVOCATION, `image >50 MB (${(bytes / 1e6).toFixed(1)} MB)`);
  const state = loadState();
  const existing = state.refs.find((r) => r.path === p);
  if (existing) {
    out({ ok: true, ref: existing, existing: true });
    return EXIT.OK;
  }
  const ref: RefEntry = { id: shortId("ref"), path: p, mime, bytes, added: nowIso() };
  state.refs.push(ref);
  saveState(state);
  out({ ok: true, ref, existing: false });
  return EXIT.OK;
}

function refsList(limit: number): number {
  const state = loadState();
  const refs = state.refs.slice(-limit);
  out({ ok: true, refs, total: state.refs.length, truncated: state.refs.length > refs.length });
  return EXIT.OK;
}

function refsRemove(id: string): number {
  const state = loadState();
  const before = state.refs.length;
  state.refs = state.refs.filter((r) => r.id !== id);
  if (state.refs.length === before) {
    fail(EXIT.INVOCATION, `no ref with id: ${id}`, `list refs: imagen refs list`);
  }
  saveState(state);
  out({ ok: true, removed: id });
  return EXIT.OK;
}

function refsClear(yes: boolean): number {
  if (!yes) fail(EXIT.INVOCATION, "refusing to clear refs without --yes", "re-run with --yes to confirm");
  const state = loadState();
  const count = state.refs.length;
  state.refs = [];
  saveState(state);
  out({ ok: true, removed: count });
  return EXIT.OK;
}

function historyCmd(limit: number): number {
  const state = loadState();
  const items = state.history.slice(-limit);
  out({
    ok: true,
    cwd: state.cwd,
    last_image: state.last_image ?? null,
    history: items,
    total: state.history.length,
    truncated: state.history.length > items.length,
  });
  return EXIT.OK;
}

function resetCmd(yes: boolean): number {
  if (!yes) fail(EXIT.INVOCATION, "refusing to reset session without --yes", "re-run with --yes to confirm");
  const state = loadState();
  state.last_image = undefined;
  saveState(state);
  out({ ok: true, reset: "last_image", refs_kept: state.refs.length, history_kept: state.history.length });
  return EXIT.OK;
}

function profileSave(name: string, p: ParsedArgs): number {
  const size = flagString(p, "size");
  const quality = validateChoice(flagString(p, "quality"), ALLOWED_QUALITIES, "quality");
  const outputFormat = validateChoice(flagString(p, "output-format"), ALLOWED_OUTPUT_FORMATS, "output-format");
  const compressionRaw = p.flags["output-compression"];
  const outputCompression = typeof compressionRaw === "number" ? compressionRaw : undefined;
  const file = loadProfiles();
  const profile: Profile = {
    name,
    size,
    quality,
    output_format: outputFormat,
    output_compression: outputCompression,
    style: flagString(p, "style"),
    refs: flagArr(p, "ref").length ? flagArr(p, "ref") : undefined,
    notes: flagString(p, "notes"),
  };
  file.profiles[name] = profile;
  saveProfiles(file);
  out({ ok: true, profile });
  return EXIT.OK;
}

function profileList(): number {
  const file = loadProfiles();
  const list = Object.values(file.profiles);
  out({ ok: true, profiles: list, total: list.length });
  return EXIT.OK;
}

function profileShow(name: string): number {
  const file = loadProfiles();
  const p = file.profiles[name];
  if (!p) {
    const known = Object.keys(file.profiles);
    fail(EXIT.INVOCATION, `unknown profile: ${name}`,
      known.length ? `available: ${known.join(", ")}` : `no profiles saved yet`);
  }
  out({ ok: true, profile: p });
  return EXIT.OK;
}

function profileDelete(name: string, yes: boolean): number {
  if (!yes) fail(EXIT.INVOCATION, "refusing to delete profile without --yes", "re-run with --yes");
  const file = loadProfiles();
  if (!file.profiles[name]) fail(EXIT.INVOCATION, `unknown profile: ${name}`);
  delete file.profiles[name];
  saveProfiles(file);
  out({ ok: true, deleted: name });
  return EXIT.OK;
}

function describe(): number {
  const cliCheck = spawnSync("openai", ["--version"], { stdio: "ignore" });
  out({
    name: "imagen",
    version: VERSION,
    protocol_version: PROTOCOL_VERSION,
    description: "Generate and edit images via OpenAI gpt-image-2. Wraps the official `openai` CLI.",
    skill_path: SKILL_DIR,
    env_file: ENV_FILE,
    state_file: statePathForCwd(),
    profiles_file: PROFILES_PATH,
    api_key_set: !!process.env.OPENAI_API_KEY,
    openai_cli_available: !cliCheck.error && cliCheck.status === 0,
    available_profiles: Object.keys(loadProfiles().profiles),
    fixed: { model: MODEL, moderation: MODERATION },
    defaults: { size: DEFAULT_SIZE, quality: DEFAULT_QUALITY, output_format: DEFAULT_OUTPUT_FORMAT },
    enums: {
      quality: ALLOWED_QUALITIES,
      output_format: ALLOWED_OUTPUT_FORMATS,
      ref_mime: Array.from(ALLOWED_REF_MIME),
    },
    size_rules: {
      description: "gpt-image-2 accepts arbitrary WxH strings. Both edges must be multiples of 16. Aspect ratio max 3:1. Pixel range 655,360 to 8,294,400. Max edge 3840.",
      common: ["1024x1024", "1024x1536", "1536x1024", "2048x2048", "1920x1080", "1080x1920", "3840x2160"],
      auto: "use 'auto' to let the model pick a size",
    },
    commands: {
      generate: {
        summary: "Create a fresh image. With --ref, behaves like `edit` using the first ref as source.",
        positional: { prompt: { type: "string", required: true } },
        flags: {
          "--ref <id-or-path>": { type: "string[]", repeatable: true },
          "--size": { type: "string", default: DEFAULT_SIZE, description: "Any WxH or 'auto'. See size_rules." },
          "--quality": { type: "enum", values: ALLOWED_QUALITIES, default: DEFAULT_QUALITY },
          "--style": { type: "string", description: "Style prefix prepended to the prompt." },
          "--output-format": { type: "enum", values: ALLOWED_OUTPUT_FORMATS, default: DEFAULT_OUTPUT_FORMAT },
          "--output-compression": { type: "number", description: "0–100 for jpeg/webp. Ignored for png." },
          "--out": { type: "path" },
          "--profile": { type: "string" },
          "--dry-run": { type: "bool" },
        },
      },
      edit: {
        summary: "Iterate on the previous image (or --from <path>).",
        positional: { prompt: { type: "string", required: true } },
        flags: {
          "--from": { type: "path", description: "Source image path (default: last image in this directory)" },
          "--ref <id-or-path>": { type: "string[]", repeatable: true, description: "Additional reference images (multi-image edit). gpt-image-2 accepts up to 16 inputs total." },
          "--size": { type: "string", default: DEFAULT_SIZE },
          "--quality": { type: "enum", values: ALLOWED_QUALITIES, default: DEFAULT_QUALITY },
          "--style": { type: "string" },
          "--output-format": { type: "enum", values: ALLOWED_OUTPUT_FORMATS, default: DEFAULT_OUTPUT_FORMAT },
          "--output-compression": { type: "number" },
          "--out": { type: "path" },
          "--profile": { type: "string" },
          "--dry-run": { type: "bool" },
        },
      },
      "refs add": { positional: { path: { type: "path", required: true } }, idempotent: true },
      "refs list": { flags: { "--limit": { type: "number", default: 50 } } },
      "refs remove": { positional: { id: { type: "string", required: true } } },
      "refs clear": { flags: { "--yes": { type: "bool", required_for_destructive: true } } },
      "profile save": {
        positional: { name: { type: "string", required: true } },
        flags: {
          "--size": { type: "string" },
          "--quality": { type: "enum", values: ALLOWED_QUALITIES },
          "--style": { type: "string" },
          "--output-format": { type: "enum", values: ALLOWED_OUTPUT_FORMATS },
          "--output-compression": { type: "number" },
          "--ref": { type: "string[]", repeatable: true },
          "--notes": { type: "string" },
        },
      },
      "profile list": {},
      "profile show": { positional: { name: { type: "string", required: true } } },
      "profile delete": { positional: { name: { type: "string", required: true } }, flags: { "--yes": { type: "bool" } } },
      history: { flags: { "--limit": { type: "number", default: 20 } } },
      reset: { flags: { "--yes": { type: "bool", required_for_destructive: true } } },
      setup: { description: "Interactive (TTY-only) one-time API key setup." },
      describe: { description: "Emit this schema." },
    },
    conventions: {
      stdout: "JSON only",
      stderr: "interactive prompts (setup) or empty",
      exit_codes: {
        "0": "success",
        "2": "invocation error (bad flag, missing arg, validation)",
        "3": "upstream service error (API failure, network, 5xx)",
        "4": "config error (missing key, unverified org, unauthorized)",
        "5": "state error (corrupt cache, missing source file)",
      },
      error_shape: { ok: false, error: "...", hint: "...", requires_tty: "true|absent" },
      precedence: "explicit flag > profile > default",
      key_resolution: ["env $OPENAI_API_KEY", `.env at ${ENV_FILE}`],
      runtime_dependency: "the `openai` CLI must be on PATH (https://github.com/openai/openai-cli)",
    },
  });
  return EXIT.OK;
}

// ---------- help ----------

const HELP_GLOBAL = `Usage: imagen <command> [options]

Commands:
  generate <prompt>          Create a fresh image.
  edit <prompt>              Iterate on the previous image (or --from <path>).
  refs add <path>            Register a reference image; returns ref_xxxx.
  refs list                  List registered refs (--limit).
  refs remove <id>           Remove a ref by id.
  refs clear --yes           Clear all refs in this directory.
  profile save <name>        Save a config profile (size, quality, style, etc.).
  profile list               List saved profiles.
  profile show <name>        Show one profile.
  profile delete <name> --yes
  history                    Show this directory's session history.
  reset --yes                Drop last_image (next \`edit\` won't have a default source).
  setup                      Interactive (TTY) one-time API key setup.
  describe                   Emit the full machine-readable schema.

Common flags (generate / edit):
  --ref <id-or-path>         Reference image (repeatable). For \`generate\` the
                             first ref becomes the source (auto-promotes to edit).
  --size <s>                 Any WxH or 'auto' (default ${DEFAULT_SIZE}).
                             gpt-image-2: edges multiple of 16, ratio ≤ 3:1, max 3840.
  --quality <q>              ${ALLOWED_QUALITIES.join(" | ")} (default ${DEFAULT_QUALITY})
  --style <s>                Free-form style prefix prepended to the prompt
                             (e.g. "photorealistic", "flat vector illustration").
  --output-format <f>        ${ALLOWED_OUTPUT_FORMATS.join(" | ")} (default ${DEFAULT_OUTPUT_FORMAT})
  --output-compression <n>   0–100 for jpeg/webp (ignored for png).
  --out <path>               Output path (default ./image-NNN.<ext>).
  --profile <name>           Apply a saved profile (explicit flags override).
  --from <path>              (edit only) Source image path.
  --dry-run                  Preview the request, don't call the API.

Output is JSON on stdout. Errors are JSON on stdout with exit code:
  0 success | 2 invocation | 3 upstream | 4 config | 5 state

Model: ${MODEL} (fixed). Moderation: ${MODERATION} (fixed).

Run \`imagen <command> --help\` for command-specific help.
Run \`imagen describe\` for the full machine-readable schema.

Key resolution:  \$OPENAI_API_KEY, then ${ENV_FILE}
Runtime:         requires \`bun\` and \`openai\` CLI on PATH.
`;

const HELP: Record<string, string> = {
  generate: `Usage: imagen generate <prompt> [options]

Create a fresh image from a prompt. With --ref, the first ref becomes
the source image and the call is rerouted through the edit endpoint.

Options:
  --ref <id-or-path>          Reference image (repeatable)
  --size <s>                  Default ${DEFAULT_SIZE}
  --quality <q>               ${ALLOWED_QUALITIES.join(" | ")} (default ${DEFAULT_QUALITY})
  --style <s>                 Style prefix prepended to the prompt
  --output-format <f>         ${ALLOWED_OUTPUT_FORMATS.join(" | ")} (default ${DEFAULT_OUTPUT_FORMAT})
  --output-compression <n>    0–100 for jpeg/webp
  --out <path>                Output path
  --profile <name>            Apply saved profile
  --dry-run                   Preview without calling the API
`,
  edit: `Usage: imagen edit <prompt> [options]

Iterate on a previous image. Default source is the last image in this
directory; override with --from <path>.

Options:
  --from <path>               Source image (default: last in this directory)
  --ref <id-or-path>          Additional reference image (repeatable)
  --size <s>                  Default ${DEFAULT_SIZE}
  --quality <q>               ${ALLOWED_QUALITIES.join(" | ")} (default ${DEFAULT_QUALITY})
  --style <s>                 Style prefix prepended to the prompt
  --output-format <f>         ${ALLOWED_OUTPUT_FORMATS.join(" | ")} (default ${DEFAULT_OUTPUT_FORMAT})
  --output-compression <n>    0–100 for jpeg/webp
  --out <path>                Output path
  --profile <name>            Apply saved profile
  --dry-run                   Preview without calling the API
`,
  refs: `Usage: imagen refs <add|list|remove|clear> [args]

  refs add <path>             Register a reference image; returns ref_xxxx
  refs list [--limit N]       List registered refs (default limit 50)
  refs remove <id>            Remove a ref by id
  refs clear --yes            Clear all refs (destructive, requires --yes)
`,
  profile: `Usage: imagen profile <save|list|show|delete> [args]

  profile save <name> [flags] Save a profile (size, quality, style, output-format, etc.)
  profile list                List saved profiles
  profile show <name>         Show one profile
  profile delete <name> --yes Delete a profile (requires --yes)

Stored at ${PROFILES_PATH}.
`,
  history: `Usage: imagen history [--limit N]

Show this directory's session history (last N entries; default 20).
`,
  reset: `Usage: imagen reset --yes

Drop last_image for this directory. Refs and history are kept.
Subsequent \`edit\` calls will require --from <path>.
`,
  setup: `Usage: imagen setup

Interactive (TTY-only) one-time API key setup. Writes to ${ENV_FILE}
with mode 0600.
`,
  describe: `Usage: imagen describe

Emit the full machine-readable schema (commands, flags, enums, defaults,
conventions, exit codes) as JSON. No API call.
`,
};

function printHelp(subcommand?: string): void {
  if (subcommand && HELP[subcommand]) {
    process.stdout.write(HELP[subcommand]!);
  } else {
    process.stdout.write(HELP_GLOBAL);
  }
}

// ---------- main ----------

async function main(): Promise<number> {
  loadEnvFile();
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    printHelp();
    return EXIT.OK;
  }

  const p = parseArgs(argv);

  if (flagBool(p, "version")) {
    out({ version: VERSION, protocol_version: PROTOCOL_VERSION });
    return EXIT.OK;
  }
  if (flagBool(p, "help") || p.subcommand[0] === "help") {
    printHelp(p.subcommand[0] === "help" ? p.positional[0] : p.subcommand[0]);
    return EXIT.OK;
  }

  const root = p.subcommand[0];
  const sub = p.subcommand[1];

  if (!root) {
    fail(EXIT.INVOCATION, "no subcommand given", "run `imagen help` for available commands");
  }

  if (root === "generate" || root === "gen") {
    const prompt = p.positional.join(" ").trim();
    const compression = p.flags["output-compression"];
    const merged = applyProfile(
      {
        size: flagString(p, "size"),
        quality: validateChoice(flagString(p, "quality"), ALLOWED_QUALITIES, "quality"),
        outputFormat: validateChoice(flagString(p, "output-format"), ALLOWED_OUTPUT_FORMATS, "output-format"),
        outputCompression: typeof compression === "number" ? compression : undefined,
        style: flagString(p, "style"),
        ref: flagArr(p, "ref").length ? flagArr(p, "ref") : undefined,
      },
      flagString(p, "profile"),
    );
    const state = loadState();
    const refs = (merged.ref ?? []).map((r) => resolveRef(state, r));
    return runGeneration({
      prompt,
      command: "generate",
      source: null,
      refs,
      size: merged.size ?? DEFAULT_SIZE,
      quality: merged.quality ?? DEFAULT_QUALITY,
      outputFormat: merged.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
      outputCompression: merged.outputCompression,
      style: merged.style,
      outPath: flagString(p, "out"),
      dryRun: flagBool(p, "dry-run"),
    });
  }

  if (root === "edit") {
    const prompt = p.positional.join(" ").trim();
    const compression = p.flags["output-compression"];
    const merged = applyProfile(
      {
        size: flagString(p, "size"),
        quality: validateChoice(flagString(p, "quality"), ALLOWED_QUALITIES, "quality"),
        outputFormat: validateChoice(flagString(p, "output-format"), ALLOWED_OUTPUT_FORMATS, "output-format"),
        outputCompression: typeof compression === "number" ? compression : undefined,
        style: flagString(p, "style"),
        ref: flagArr(p, "ref").length ? flagArr(p, "ref") : undefined,
      },
      flagString(p, "profile"),
    );
    const state = loadState();
    let source: string | null = null;
    const fromFlag = flagString(p, "from");
    if (fromFlag) {
      const fp = expandPath(fromFlag);
      if (!existsSync(fp)) fail(EXIT.STATE, `--from path does not exist: ${fp}`);
      source = fp;
    } else if (state.last_image && existsSync(state.last_image)) {
      source = state.last_image;
    } else {
      fail(EXIT.INVOCATION, "no previous image in this directory and no --from given",
        "use `imagen generate <prompt>` for a fresh image, or pass --from <path>");
    }
    const refs = (merged.ref ?? []).map((r) => resolveRef(state, r));
    return runGeneration({
      prompt,
      command: "edit",
      source,
      refs,
      size: merged.size ?? DEFAULT_SIZE,
      quality: merged.quality ?? DEFAULT_QUALITY,
      outputFormat: merged.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
      outputCompression: merged.outputCompression,
      style: merged.style,
      outPath: flagString(p, "out"),
      dryRun: flagBool(p, "dry-run"),
    });
  }

  if (root === "refs") {
    if (sub === "add") {
      const path = p.positional[0];
      if (!path) fail(EXIT.INVOCATION, "refs add requires a path argument");
      return refsAdd(path);
    }
    if (sub === "list") return refsList(flagNum(p, "limit", 50));
    if (sub === "remove") {
      const id = p.positional[0];
      if (!id) fail(EXIT.INVOCATION, "refs remove requires a ref id");
      return refsRemove(id);
    }
    if (sub === "clear") return refsClear(flagBool(p, "yes"));
    fail(EXIT.INVOCATION, `unknown refs subcommand: ${sub ?? "(none)"}`, "use: refs add | list | remove | clear");
  }

  if (root === "profile") {
    if (sub === "save") {
      const name = p.positional[0];
      if (!name) fail(EXIT.INVOCATION, "profile save requires a name");
      return profileSave(name, p);
    }
    if (sub === "list") return profileList();
    if (sub === "show") {
      const name = p.positional[0];
      if (!name) fail(EXIT.INVOCATION, "profile show requires a name");
      return profileShow(name);
    }
    if (sub === "delete") {
      const name = p.positional[0];
      if (!name) fail(EXIT.INVOCATION, "profile delete requires a name");
      return profileDelete(name, flagBool(p, "yes"));
    }
    fail(EXIT.INVOCATION, `unknown profile subcommand: ${sub ?? "(none)"}`, "use: profile save | list | show | delete");
  }

  if (root === "history") return historyCmd(flagNum(p, "limit", 20));
  if (root === "reset") return resetCmd(flagBool(p, "yes"));
  if (root === "setup") return await setupCommand();
  if (root === "describe") return describe();

  fail(EXIT.INVOCATION, `unknown command: ${root}`, "run `imagen help` for available commands");
}

main().then((code) => process.exit(code)).catch((e) => {
  out({ ok: false, error: `fatal: ${(e as Error).message ?? String(e)}` });
  process.exit(1);
});
