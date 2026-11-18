# BlockFlow frontend

The Next.js frontend for BlockFlow, a local pipeline builder for AI image and
video generation. Build visual workflows, chain blocks together, and run them
with a single click.

> **Local only** — runs entirely on your machine. Nothing is deployed or hosted.

---

## Running

From the repository root:

```bash
uv run app.py
```

Then open [http://localhost:47300](http://localhost:47300).

This starts both the FastAPI backend (port 47301) and the Next.js frontend
(port 47300). Override with the `BACKEND_PORT`/`FRONTEND_PORT` env vars.

Provider API keys (Kie and PiAPI) are entered in **Settings → API keys** or in the
first-start Welcome dialog; they are stored by the backend, never in the browser.
See the [main README](../README.md).

---

## Building a pipeline

1. **Open the Generate tab** — you'll see an empty canvas with a `+` button
2. **Add your first block** — click `+` to choose a block type
3. **Chain blocks together** — use the `+` at the end of the chain, or the `+` between existing blocks to insert in the middle
4. **Configure each block** — click a block to expand its settings
5. **Click "Run Pipeline"** — all blocks execute in order; outputs flow automatically

---

## Blocks

| Block | What it does |
|-------|-------------|
| **Text to Video / Image to Video / Omni Reference to Video / Text to Image / Image to Image** | Generate with Kie or PiAPI; the provider and model selectors come from the capability ledger |
| **Upload Image** | Upload local images; outputs a local path and, if enabled, a temporary public URL |
| **Video Loader** | Upload a local video or paste a URL |
| **Prompt From Txt** | Read prompts from a text file |
| **Image Inspector** | Load images and read their embedded generation metadata |
| **Video FX** | Apply simple video effects |
| **Video Stitcher** | Join videos end to end |
| **Human-in-the-Loop** | Pause the pipeline and manually approve or reject before continuing |
| **Image / Video / Audio Viewer** | Display outputs inline |

---

## Output files

Generated files are saved to the output folder (see the [main README](../README.md)). Files with embedded
generation metadata show a green **META** badge on the **Artifacts** page.

---

## Development

Blocks auto-register: drop a `frontend.block.tsx` (and optionally
`backend.block.py`) into `custom_blocks/<slug>/` and run `npm run gen:custom-blocks`.

```bash
npm run dev     # dev server with hot reload
npm test        # Vitest
npm run build   # production build
```
