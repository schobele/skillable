# skillable

A library of Claude Code plugins.

Each plugin is a focused agent-native CLI: structured JSON output, a
machine-readable schema, predictable error shapes, and exit codes you
can branch on. Plugins ship as single TypeScript files run directly
via [Bun](https://bun.sh) — no build step, no `node_modules`.

## Install

```
/plugin marketplace add schobele/skillable
/plugin install skillable@skillable
```

After install, Claude can invoke skills by namespace, e.g.
`/skillable:imagen`.

## Plugins

| Plugin | Skill | Description |
| --- | --- | --- |
| [`skillable`](plugins/skillable) | `/skillable:imagen` | Generate and edit images with OpenAI `gpt-image-2`. |

## Shared conventions

Every plugin in this library follows the same surface so agents can
treat them uniformly:

- **Output is JSON on stdout**, always. No `--json` flag — it's the
  default.
- **Errors are JSON** with shape `{ok: false, error, hint}`. If the
  failure requires the user to do something interactive (run a setup
  command, paste a key), the error includes `requires_tty: true` so
  the caller knows to relay the message verbatim.
- **Exit codes are taxonomic**, so callers can branch on category:
  - `0` success
  - `2` invocation error (bad flag, missing arg, validation)
  - `3` upstream service error (API failure, network, 5xx)
  - `4` config error (missing key, unverified org, unauthorized)
  - `5` state error (corrupt cache, missing source file)
- **`--yes` is required** for destructive operations.
- **`describe` subcommand** emits the full machine-readable schema —
  commands, flags, enums, defaults, conventions — as JSON. Plus a
  `protocol_version` field, lockstep with these conventions, so agents
  can detect schema changes.
- **`<command> --help`** prints command-specific human-readable help.
- **State** lives at `~/.cache/<name>/` (per-directory) and
  `~/.config/<name>/` (global).

## Development

Type-check tooling lives in [`dev/`](dev), separate from shipped
plugins so installs stay small.

```bash
cd dev
bun install
bun run typecheck
```

## License

[MIT](LICENSE)
