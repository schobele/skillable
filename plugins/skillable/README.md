# imagen

CLI for generating and editing images with OpenAI `gpt-image-2`. Wraps
the official [`openai`](https://github.com/openai/openai-cli) CLI; ships
as a single TypeScript file run directly via [Bun](https://bun.sh).

The model is fixed to `gpt-image-2` and moderation is fixed to `low`.

## Requirements

- `bun` ≥ 1.3
- `openai` CLI (`brew install openai-cli` or `pip install openai-cli`)
- An OpenAI API key with [organization verification](https://platform.openai.com/settings/organization/general) for `gpt-image-*` models

## Setup

```bash
imagen setup
```

Prompts for `OPENAI_API_KEY` and writes it to
`<plugin>/skills/imagen/.env` with mode `0600`.

## Usage

```bash
imagen generate "a fox in a forest" --style "photorealistic, golden hour"
imagen edit "Make only the sky a sunset. Keep the fox, trees, and framing the same."
imagen refs add ./sketch.png
imagen generate "in this style" --ref ref_a8f12d3c
imagen generate "..." --output-format jpeg --output-compression 85
imagen history
```

`imagen --help` for the global flag reference, `imagen <command>
--help` for command-specific help, `imagen describe` for the full
machine-readable schema. See `SKILL.md` for prompting craft notes
(prompt structure, edits with preserve lists, multi-image inputs,
common failure modes).

## Conventions

- Output is JSON on stdout. All commands. No flag needed.
- Errors are JSON with `{ok: false, error, hint}`; setup-style errors
  include `requires_tty: true` so callers know to relay them to a human.
- Exit codes: `0` success | `2` invocation | `3` upstream | `4` config
  | `5` state.
- `--yes` required for destructive operations (`refs clear`, `profile
  delete`, `reset`).
- Per-directory state at `~/.cache/imagen/`; profiles at
  `~/.config/imagen/profiles.json`.
- Output filename extension matches the actual returned bytes — the
  model occasionally returns a different format than requested.

## Iteration

`edit` reuses the most recent image generated in the current directory
as the source for the next call. Override with `--from <path>`.
Switching directories starts a new chain. State all preserved elements
explicitly on every edit — drift compounds otherwise.

## License

[MIT](../../LICENSE)
