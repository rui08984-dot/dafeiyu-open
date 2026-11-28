# DaFeiyu — a desktop AI companion that lives on your screen

> A Windows desktop companion in a transparent 420×760 window: she talks, shows expressions, sees your screen, hears your voice, and can operate your PC.
>
> Based on [morettt/my-neuro](https://github.com/morettt/my-neuro) (MIT), with upstream attribution; third-party asset licenses are listed in `NOTICE`. This is not an official upstream release.

## Install (Windows 10/11 x64)

Download **`DaFeiyu-Setup-0.5.2.exe`** (~120 MB) from [Releases](https://github.com/rui08984-dot/dafeiyu-open/releases/latest) and run it.

On first launch the settings window opens on the **Model** page: paste an API key for any OpenAI-compatible endpoint, press Save, and start chatting. No restart needed.

- Included: Live2D model + Cubism Core, Rust core (`pet-core`: screen capture / window control fast path), edge-tts voice (free, online, no key), performance data and the current persona.
- Full capability is installed on demand under **Settings → Components** (8 components, 5,539.3 MB / ~5.5 GB total; install only what you need): Python runtime, long-term memory, push-to-talk ASR, co-watch, semantic motion, voiceprint, local 4B memory model, local vision/OCR. Models come from ModelScope / hf-mirror; restart DaFeiyu after installing.
- New in v0.5.0: `voiceprint` (263.5 MB, resemblyzer + CPU torch), `local-memory` (2,381.6 MB, MemOperator-4B, CPU inference, hf-mirror), `ollama` (1,637.8 MB portable Ollama v0.40.18; its three models ~9.3 GB are pulled on demand; `paddleocr-vl` is not in the official registry and is optional).
- v0.5.1 fixes: no dev rotated logs in the installer (build-time assertion), memory-consistency check and the browser-tabs extension now ship with the installer, capability page resolves component-installed organs, and a fresh clone can rebuild component packs (missing weights are downloaded from manifest sources with sha256 verification; persona kernel / Lumen config have in-repo fallbacks).
- v0.5.2: **first-run prompt installs everything** — on first launch a dialog pre-selects all 8 components (all lit) and installs them in one click; it shows 5,539 MB total, ~9.3 GB for local-vision models, ≥16 GB disk, and an 8 GB VRAM note; it appears once, can be postponed, and the Components page stays available. Also fixes the RSS delivery cache reading stale data after same-millisecond rewrites (world-extras mtime+size key).
- The installer is unsigned; Windows SmartScreen may warn about an unknown publisher. Choose "Run anyway".

## What she can do

| Capability | Implementation |
|---|---|
| Speak | edge-tts, emotion-driven rate/pitch/volume, per-clause prosody, streaming first chunk |
| Expressions & motion | Live2D Cubism 5, 509 parameters; FACS/VAD performance layer, asymmetric expressions, physics two-phase commit |
| See the screen | Rust GDI capture (~54ms at 2560×1440) + multimodal model; local vision organ for summaries/OCR |
| Hear you | SenseVoice ASR + voiceprint + acoustic understanding; co-watch system-audio loopback (full stack) |
| Operate Windows | UIA element clicks / vision-coordinate clicks / SendInput / PostMessage for games / window focus |
| Remember you | MemOS + Qdrant vectors; four-layer memory arbitration (full stack) |
| Act alive | Human-like performance scheduler: director budgets, 6-state ambient layer, show programs, 97 FACS clips (P0–P3) |

## Requirements

- Windows 10/11 x64.
- An LLM API key (any OpenAI-compatible endpoint).
- Full source stack only: Node.js ≥ 20, Python 3.13 (`py` launcher), optional Docker Desktop (embeddings) and Ollama (local vision/OCR).

## Run from source

```bat
REM 1) dependencies
cd _incoming\my-neuro\live-2d && npm install && cd ..\..\..
cd pet-runtime && npm install && cd ..

REM 2) first-run wizard (key from an environment variable; never echoed)
set COMAD_BUNNY_API_KEY=...
node scripts\install-wizard.mjs --dry-run --json
node scripts\install-wizard.mjs --provider=comad --yes

REM 3) check, build the avatar bundle, start
node scripts\bootstrap.mjs
node pet-runtime\build-and-deploy-petbody.mjs
大肥鱼 start
```

Chinese guide: `README.md`. Architecture and ADRs: `docs/adr/`.

## License & attribution

- Our code: MIT (`LICENSE`). Third-party boundaries: `NOTICE`.
- Live2D model DeepSeek-chan / DaFeiyu: bundled with the model author's permission (see `NOTICE`).
- Live2D Cubism Core/Framework: proprietary, distributed as "Redistributable Code" under the Live2D license (see `pet-runtime/desktop/vendor/cubism/Framework/LICENSE.md`).
- MemOS: Apache-2.0 (see its `LICENSE` / `NOTICE`).
- Upstream: morettt/my-neuro (MIT).
