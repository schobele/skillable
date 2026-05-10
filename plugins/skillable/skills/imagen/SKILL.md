---
name: imagen
version: 1.0.0
description: |
  Generate or edit images with OpenAI gpt-image-2. Subcommands: generate
  (fresh image), edit (iterate on the last image or a given path), refs
  (register reference images), profile (saved configs), history, reset,
  setup, describe. Output is JSON. Multi-image edits via repeatable
  --ref (up to 16). Use whenever the user asks to create, generate,
  draw, render, edit, restyle, transform, extend, or iterate on an
  image.
allowed-tools:
  - Bash
  - Read
  - Write
---

# imagen

Wraps the OpenAI `openai` CLI. Iteration is file-based: the most recent
image generated in the current directory is reused as the source for the
next `edit`.

Model is fixed to `gpt-image-2`. Moderation is fixed to `low`. Run
`imagen describe` for the live JSON schema of every command and flag,
or `imagen <command> --help` for command-specific help text.

## Routing

| Request | Command |
| --- | --- |
| Create an image of X | `imagen generate "X"` |
| Now make it Y / change Z / add W | `imagen edit "..."` |
| Use this attached image | `imagen refs add <path>` then `generate --ref <id>` |
| Use these images | `refs add` each, then `generate --ref id1 --ref id2 "..."` |
| Show prior images | `imagen history` |
| Start over | `imagen generate "..."` (no `--from`) |
| What flags are available | `imagen describe` |

`generate` with `--ref` switches to the edit endpoint with the first ref
as the source image — a single `generate` call covers "use this image
and put it in a forest".

## Setup

If a call returns `OPENAI_API_KEY missing or invalid` (`requires_tty:
true` in the JSON error), ask the user to run this in their terminal —
it requires a TTY:

```bash
imagen setup
```

The OpenAI account must also have organization verification enabled to
use `gpt-image-*` models.

## Prompting craft

gpt-image-2 is a natural-language model with reasoning, not a
keyword-soup model. Write prompts the way you'd brief a designer.

### Think before you prompt

A vague prompt produces a generic image. Before calling `generate`,
spend a few seconds answering four questions:

1. **Purpose.** What is this image *for* — a hero banner, a tutorial
   diagram, a debug visual, a card thumbnail, a mood reference? The
   purpose decides the medium, the polish level, and what counts as
   success.
2. **Subject + verb.** What is happening, in one sentence. "A cat is
   sitting on a stool" beats "a cat scene". An action implies pose,
   framing, and the moment in time the camera caught.
3. **Mood + medium.** Pick *one* dominant feeling (calm, urgent,
   nostalgic, clinical) and *one* medium (photo, flat illustration,
   3D render, pencil sketch). Two of either start to fight each other.
4. **Three concrete anchors.** Pick three specific details a viewer
   would notice first: the brass kettle, the morning light through
   slats, the wet cobblestones. Vague nouns ("decor", "lighting",
   "atmosphere") rarely survive the model.

If your draft prompt could describe five wildly different images,
you're not done thinking yet.

### Ground the prompt in reality

The model knows what real things look like — but only if you name them
specifically. Before prompting on anything you're not 100% sure of,
check the references and encode the specifics:

- **Real entities** (people, places, products, animals, brands):
  verify what they actually look like before describing them. The
  Sydney Opera House has distinctive sail-shaped shells; a red panda
  is not a small red giant panda; a Sennheiser HD 600 has a specific
  oval cup and grille pattern.
- **Technical diagrams** (LSTM cells, biology cross-sections, circuit
  schematics, anatomy): look up the canonical layout. An LSTM cell
  has specific gates (forget, input, output) in a specific arrangement
  — name them. Generic "a diagram of X" rarely produces an accurate X.
- **Period or style references** (Bauhaus poster, ukiyo-e print,
  Edward Hopper interior, brutalist architecture): named styles beat
  adjectives. "An Edward Hopper diner interior at 2am" gives the model
  far more to work with than "a moody empty diner".
- **Brand language** (logos, product photography, packaging): if the
  user is asking for something on-brand, look up the brand's actual
  visual language — palette, typography, photography style.

When in doubt, use Claude's tools to look it up before prompting:
WebSearch for current visual references, WebFetch for brand guidelines
or technical documentation, Read for any local reference images. Treat
the prompt as a brief grounded in research, not a guess.

### Prompt shape

Order your prompt as **scene → subject → key details → constraints**.
Short labelled segments or line breaks beat one long paragraph.

```
A 1970s diner counter at night, neon sign flickering outside.
Subject: a tabby cat sitting on a barstool, paws on the counter.
Details: chrome stools, checkered floor, glass sugar dispenser, pie under glass.
Constraints: photorealistic, soft cinematic light, no text, no humans.
```

### Compose like a director

The model rewards composition vocabulary. Name the camera, the light,
and the layout the way a cinematographer or art director would.

**Framing.** close-up | medium shot | wide | full-body | establishing |
top-down | over-the-shoulder | dutch angle.

**Angle and viewpoint.** eye-level | low-angle (heroic) | high-angle
(diminishing) | three-quarter | bird's-eye | worm's-eye.

**Lens language as vibe, not physics.** "shallow depth of field with
the background falling soft" beats "85mm f/1.4". The model interprets
exact camera specs loosely; use them as flavour, not exact simulation.

**Lighting as mood.** soft window light (intimate) | golden hour
(warm, low contrast) | overcast (even, melancholy) | studio softbox
(commercial, neutral) | neon side-light (cinematic, saturated) |
single hard rim light (dramatic). Specify the direction and quality.

**Layout placement.** The model will respect named placement: "subject
in the lower-third left", "logo top-right", "horizon line at the
two-thirds mark", "negative space on the right for caption".

**Depth.** Build foreground / midground / background explicitly. "A
brass key in sharp focus in the foreground; a blurred wooden door in
the midground; a softly lit hallway receding behind it." Depth is what
separates a photo from a still-life.

**Colour.** Pick a dominant palette plus an accent: "muted terracotta
and bone with a single cobalt accent". Naming a palette in words is
cheaper than fighting random colour choices later.

### Specificity over abstraction

The model trades ambiguity for confidence. Replace adjectives with
nouns and verbs.

| Vague | Specific |
| --- | --- |
| "old metal" | "weathered brass with green patina at the seams" |
| "warm lighting" | "low golden sunlight through wooden blinds, slats casting stripes across the desk" |
| "rustic wood" | "rough-sawn oak planks with iron nail-heads, one knot near the centre" |
| "happy person" | "a woman mid-laugh, eyes crinkled, head tilted slightly back" |
| "modern kitchen" | "matte-black cabinetry, brushed-brass handles, marble counter, one ceramic bowl of lemons" |
| "professional photo" | "editorial product photography, soft top-down softbox, clean white seamless background" |

Three concrete anchors usually beat ten generic adjectives.

### Trigger photorealism explicitly

Include the literal word "photorealistic" to engage the photorealistic
mode. For other looks, name the medium plainly: "flat vector
illustration", "isometric 3D render", "pencil sketch", "watercolor",
"matte painting", "studio product photography".

The `--style` flag prepends a style prefix to the prompt — a clean way
to keep the user's prompt short while still naming the medium:

```bash
imagen generate "a fox in autumn forest" --style "photorealistic, golden hour"
# → prompt sent: "photorealistic, golden hour, a fox in autumn forest"
```

### Text inside images

Put literal in-image text in **double quotes**. For headlines, also use
ALL CAPS. Specify font style, placement, and colour as constraints.

```
Poster with the headline "MIDNIGHT MARATHON" in bold serif, white on black,
centered top third. Subtitle "April 4 — 8pm" in thin sans-serif below.
```

For long or unusual strings, spell them out letter by letter ("M-I-D-N-I-G-H-T")
to improve character accuracy.

### Editing

Edits work best when you say **what changes** AND **what stays**.
Without a preserve list, faces, logos, and exact text drift between
turns.

```bash
# Bad — leaves too much open
imagen edit "make the sky sunset"

# Better — locks the rest
imagen edit "Change only the sky to a sunset of pink and orange clouds. \
  Keep the cat's pose, fur pattern, the chrome stools, the counter, \
  the floor pattern, and the neon sign exactly as they are."
```

**Repeat the preserve list every turn.** Drift compounds otherwise.

For likeness-critical edits (a person's face, a brand logo), name the
elements that must stay locked explicitly each time.

### Multi-image inputs

When passing more than one image, reference each by index in the prompt
and describe how they interact:

```bash
imagen generate "Apply the colour palette from Image 2 to the scene in Image 1. \
  Keep Image 1's composition and Image 2's mood." \
  --ref ref_scene --ref ref_palette
```

gpt-image-2 accepts up to 16 input images per call.

### Iteration philosophy

Don't load every change into one prompt. Start with a clean base, then
make small single-change follow-ups: "warm the lighting", "remove the
extra tree on the left", "tighter crop". Re-state any critical detail
that starts to drift.

### Common failure modes

- **Generic and forgettable** — the prompt was short on concrete
  anchors. Add three specific nouns and a named palette/lighting.
- **Wrong reality** — a real entity rendered inaccurately (anatomy,
  architecture, product details). Look it up, then describe it
  specifically. Don't trust the model to invent the truth.
- **Drift on faces/text/logos** — the preserve list is missing or got
  shorter across turns. Restate it on every edit.
- **The model added text or hands you didn't ask for** — add explicit
  exclusions: "no text", "no humans", "no watermark".
- **Style fights subject** — too many style descriptors compete. Pick
  one medium and one mood.
- **Layout never lands** — name the placement explicitly: "logo
  top-right", "subject in lower third", "title at top, centred".
- **Depth feels flat** — no foreground / midground / background was
  named. Add layers.

### A worked example

User asks: "make me a hero image for a coffee shop website".

A weak prompt:
```
A coffee shop interior, warm and inviting.
```

A grounded, composed prompt — derived from the four pre-flight
questions (purpose: hero banner; subject: barista pulling a shot;
mood: calm morning ritual; medium: editorial photo) plus three
concrete anchors:
```bash
imagen generate \
  "Editorial photograph of a small specialty coffee shop at 7am, \
   morning light angling through tall windows. \
   Subject: a barista in a black apron pulling an espresso shot on a chrome \
   La Marzocco, steam curling from the spout, eyes focused on the timer. \
   Foreground: a row of upturned ceramic cups in soft focus on the wooden bar. \
   Midground: the espresso machine and barista in sharp focus. \
   Background: a blurred shelf of green-and-white bean bags and a hanging \
   pendant lamp. \
   Composition: subject in the right two-thirds; left third is open negative \
   space for headline overlay. \
   Mood: quiet, deliberate, early morning. \
   Constraints: no text, no signage, no other people, no watermark." \
  --style "photorealistic, soft natural light, shallow depth of field" \
  --size 1536x1024 --quality high
```

Notice: the medium is named, the moment is specific, three layers of
depth are explicit, the placement reserves space for a headline, and
the exclusions prevent unwanted additions.

## Commands

### `generate <prompt>`

```bash
imagen generate "a banana on a marble counter"
imagen generate "diagram of an LSTM cell" --size 1536x1024 --quality high
imagen generate "..." --style "photorealistic, soft window light"
imagen generate "..." --output-format jpeg --output-compression 85
imagen generate "..." --ref ref_abc123
imagen generate "..." --profile banner
imagen generate "..." --dry-run
```

### `edit <prompt>`

Reuses the last image in the current directory; pass `--from <path>` to
override.

```bash
imagen edit "Make only the cat orange. Keep the pose, background, \
  framing, and lighting the same."
imagen edit "..." --from ./favourite.png
```

### `refs add/list/remove/clear`

```bash
imagen refs add ~/Downloads/sketch.png
imagen refs list
imagen refs remove ref_a8f12d3c
imagen refs clear --yes
```

`refs add` is idempotent. The returned `ref_xxxxxx` ID is stable across
calls in the same directory.

### `profile save/list/show/delete`

```bash
imagen profile save banner \
  --size 1536x1024 --quality high \
  --style "photorealistic, soft cinematic light" \
  --output-format jpeg --output-compression 85 \
  --notes "Hero banner default"
imagen generate "..." --profile banner
```

Stored at `~/.config/imagen/profiles.json`. Explicit flags override
profile values.

### `history`, `reset`, `setup`, `describe`

```bash
imagen history --limit 10
imagen reset --yes
imagen setup
imagen describe
```

## Flags reference

| Flag | Purpose |
| --- | --- |
| `--size` | Any `WxH` or `auto` (default `1024x1024`). gpt-image-2 accepts arbitrary sizes — both edges multiples of 16, ratio ≤ 3:1, max edge 3840. |
| `--quality` | `low` \| `medium` \| `high` \| `auto`. Use `low` for drafts, `high` for final. |
| `--style` | Free-form style prefix prepended to the prompt. |
| `--output-format` | `png` (default) \| `jpeg` \| `webp`. JPEG is the smallest and fastest. |
| `--output-compression` | 0–100 quality for jpeg/webp. Ignored for png. |
| `--ref` | Reference image (id or path). Repeatable (up to 16 inputs). |
| `--from` | (`edit` only) Source image path. Defaults to last image in this directory. |
| `--out` | Output path. Default `./image-NNN.<ext>`, where `<ext>` matches the actual returned format. |
| `--profile` | Apply a saved profile. Explicit flags override. |
| `--dry-run` | Preview the request, don't call the API. |

## Conventions

- **Output is JSON on stdout.** All commands. No flag needed.
- Errors are JSON with `{ok: false, error, hint}`; if `requires_tty:
  true` is present, relay the message to the user verbatim — they need
  to run the command in their terminal.
- Exit codes: `0` success | `2` invocation | `3` upstream | `4` config
  | `5` state.
- `--yes` is required for `refs clear`, `profile delete`, `reset`.
- `--limit` bounds list output for `history` and `refs list`.
- Precedence: explicit flag > profile > default.
- The CLI sniffs the returned image's magic bytes to set the file
  extension. If gpt-image-2 ignores a requested format (e.g. webp on
  the edit endpoint may return PNG), the saved file matches the actual
  bytes and the response includes `requested_output_format`.

## Failure handling

| Error code + symptom | Action |
| --- | --- |
| `2` `unknown flag` / `unknown command` | Read `imagen help` or `imagen <command> --help` and retry. |
| `4` + `requires_tty: true` | Ask the user to run `imagen setup` in their terminal. Don't try to fix it for them. |
| `4` + verification | Point the user to OpenAI org settings to verify the organization. |
| `4` + `openai CLI not found` | Tell the user to install `openai-cli` (`brew install openai-cli` or `pip install openai-cli`). |
| `3` + 429 / rate limit | Suggest a brief retry. |
| `3` + moderation block | Suggest a softer rephrasing. |
| `3` + edit with no prior image (`2` actually) | Run `generate` first or pass `--from <path>`. |
| `5` + missing source / corrupt state | The cached source image was moved or deleted; pass `--from <path>` or run `imagen reset --yes`. |

## Storage

- Per-directory state: `~/.cache/imagen/<sha256(cwd)>.json` (last image, refs, history)
- Profiles: `~/.config/imagen/profiles.json`
- API key: `${CLAUDE_SKILL_DIR}/.env` (mode `0600`)
