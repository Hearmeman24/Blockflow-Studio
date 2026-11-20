<div align="center">

# BlockFlow Studio

[![CI](https://github.com/Hearmeman24/Blockflow-Studio/actions/workflows/ci.yml/badge.svg)](https://github.com/Hearmeman24/Blockflow-Studio/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Hearmeman24/Blockflow-Studio?display_name=tag&include_prereleases)](https://github.com/Hearmeman24/Blockflow-Studio/releases)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](LICENSE)
[![Sponsor](https://readme.cash/i/9dg9c5wcbr.svg)](https://readme.cash/c/9dg9c5wcbr)

Source-available visual pipelines for AI image and video generation, with your own API keys.

</div>

## Quickstart

You need [uv](https://docs.astral.sh/uv/getting-started/installation/),
[Node.js](https://nodejs.org/) 22.14 or newer, and git.

```bash
git clone https://github.com/Hearmeman24/Blockflow-Studio.git
cd Blockflow-Studio
uv run app.py
```

The first start installs the frontend packages and builds the web interface,
which can take a few minutes. Later starts take a second or two; the app
rebuilds the web interface (about a minute) only after an update, a change to a
block, or a different backend port. The app then opens at <http://localhost:47300>. Enter a Kie key, a PiAPI key, or
both in the Welcome dialog, or later in **Settings, then API keys**. Then open
**Generate**, add a block, and click **Run Pipeline**.

### Start with your AI agent

To have a coding agent do the setup instead, paste this into it:

```text
Clone https://github.com/Hearmeman24/Blockflow-Studio.git and set up BlockFlow Studio for me.
Follow the "Set up BlockFlow Studio for a user" section of AGENTS.md in the repository.
```

The agent checks the prerequisites, installs the dependencies, starts the app
and registers the MCP server. You enter your keys in the app yourself; do not
paste a key into the chat. The agent asks before anything that spends credits.
The full procedure is in [AGENTS.md](AGENTS.md).

## What this is

BlockFlow Studio is a local app for chaining blocks that load references,
generate images and videos, and show the results. On the **Generate** page you
build a left-to-right pipeline, for example Image Loader, then Image to Image,
then Image Viewer, and press **Run Pipeline**. Requests go to
[Kie](https://kie.ai/?ref=071ed206b70bc522e7626d3b4d1ad069) and
[PiAPI](https://piapi.ai/?ref=dbc2855b-3394-4052-8b8a-6dcc471bfced) with your
own keys, so you pay the providers directly. Generated files are saved on your
computer and listed on the **Artifacts** page.

It is forked from [BlockFlow](https://github.com/Hearmeman24/BlockFlow) and has
no RunPod or ComfyUI functionality. It is beta software: most provider paths
have so far only been tested against mocks, so expect bugs.

## Core capabilities

- **Six generation blocks:** Text to Image, Image to Image, Text to Video,
  Image to Video, Omni Reference to Video and Character Swap (replace the
  person in a video with the person from an image). A block only offers what
  your keys can run.
- **Cost before you run:** an estimate on each generation block, the
  provider's actual charge afterwards, and your balance per provider.
- **Characters:** saved faces, audio and reference files, reused across flows.
- **MCP server:** an AI agent can generate through the same app, with a cost
  cap.
- **Your own blocks:** a block is one folder, loaded automatically.

## Add your own blocks

A block is a folder with a `frontend.block.tsx` and, optionally, a
`backend.block.py`. Put yours in `private_blocks/<slug>/`, which is git-ignored,
so updates never touch it. A complete example is in
[AGENTS.md](AGENTS.md#adding-a-block). After adding or changing a block, start
the app again: `uv run app.py` rebuilds the web interface with it. While you
work on a block, `uv run app.py --dev` runs the development server instead,
which reloads your changes and shows errors in the page (it uses about 1 GB
more memory).

## MCP server

The MCP server lets an AI agent list models, estimate costs and generate
through the running app; results appear on the Artifacts page. `generate`
spends your provider credits and accepts a `max_cost_usd` cap; every other tool
is free. For Claude Code, with the app running, from the repository root:

```bash
claude mcp add blockflow-studio -- uv run --directory "$(pwd)" --with fastmcp mcp_server.py
```

For other MCP clients, see step 5 in [AGENTS.md](AGENTS.md#set-up-blockflow-studio-for-a-user).

## Models, prices and updates

The model and provider selectors on each block show what your keys can run.
Cost estimates come from a price list bundled with the app and refreshed from
[Hearmeman24/blockflow-prices](https://github.com/Hearmeman24/blockflow-prices).
The app checks for new releases and can update a git checkout in place
(**Settings, then App**).

## Bugs

To report a bug, open an
[issue](https://github.com/Hearmeman24/Blockflow-Studio/issues/new/choose) and
attach the output of `python3 scripts/doctor.py --json`, which contains no
keys. Never paste an API key into an issue.

## Data, ports and settings

- **Your data.** Settings, keys and history are kept in a BlockFlow Studio
  folder, separate from the original BlockFlow app's folder: macOS
  `~/Library/Application Support/BlockFlow Studio`, Windows
  `%LOCALAPPDATA%\BlockFlow Studio`, Linux `~/.local/share/blockflow-studio`.
  Set `BLOCKFLOW_DATA_DIR` to use another folder.
- **Keys.** Stored locally, readable only by your user, and never returned by
  the app's API.
- **Output folder.** Generated files go to `output` inside the data folder,
  unless you choose another folder in the Welcome dialog or in **Settings, then
  App**.
- **Ports.** Frontend `47300`, backend `47301`. To change them:
  `BACKEND_PORT=48001 FRONTEND_PORT=48000 uv run app.py`. If a port is already
  taken, or a value is not a number from 1 to 65535, the app stops before
  starting and says which.
- **No browser.** `BLOCKFLOW_NO_OPEN=1` starts the app without opening one.
- **Web interface.** `uv run app.py` serves a production build of the web
  interface, built when needed. `uv run app.py --dev` (or `BLOCKFLOW_DEV=1`)
  runs the Next.js development server; `uv run app.py --packaged` (or
  `BLOCKFLOW_PACKAGED=1`) serves the existing build and never builds. The web
  interface listens on every network address of the computer, as the
  development server always did; the backend only on this computer.
- **Repair.** `python3 scripts/doctor.py` checks the install and changes
  nothing; `uv run python scripts/setup.py` reinstalls what is missing (and the
  developer tools for tests and lint).

## License

BlockFlow Studio is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE).

You may use, study, modify, and share BlockFlow Studio for non-commercial
purposes under that license.

Commercial use is not permitted without a separate written commercial license.
This includes using BlockFlow Studio in a revenue-generating product, service,
website, client project, SaaS offering, hosted service, or internal business
workflow.

For commercial licensing, contact: hearmeman@hearmemanai.xyz.
