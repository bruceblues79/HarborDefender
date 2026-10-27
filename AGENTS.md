# 执行规则（最高优先级）

- 执行我的任务前，请先不要急着输出结果。
- 请你先识别我这个需求里所有模糊、缺失、可能影响结果的信息，并列出问题向我确认；等我补充完关键信息之后，你再正式开始执行。
- 如果你必须先做假设，请明确告诉我你做了哪些假设，不要自己硬补充。

# IWSDK project

A Vite + TypeScript or JavaScript app, but several things do **not** work the way
a normal Vite project works. Read this section before assuming anything.

Deeper material is installed in each selected harness's native path-scoped rule
format. Harnesses that use `AGENTS.md` also receive equivalent nested files near
the code they govern. Read the applicable scoped instructions before working in
that area.

Explain immersive terms in plain language when they first matter instead of
assuming the reader knows them. In particular, introduce XR (an immersive
session), IWER (IWSDK's browser-based XR emulator), ECS (entity-component
system), and controller target-ray versus grip poses with a link to the
applicable IWSDK guide or concept page.

## What is not standard Vite

**`iwsdk.config.json` is the project authority, not `vite.config.ts`.** It selects
the active scene, the asset module, the component module, and all XR/world
features. `vite.config.ts` only wires the plugin. Editing `iwsdk.config.json`
restarts Vite in place; the managed window remains open and its command bridges
reconnect automatically. Wait for `npx @iwsdk/cli dev status` to report
`browserCommandReady: true` before issuing browser-backed commands.

**`virtual:iwsdk-project` is a virtual module**, not a file. `src/index.ts` or
`src/index.js` imports it and passes it whole to `World.create()`. Do not
hand-build that options object.

**The dev server is CLI-managed.** Use `npx @iwsdk/cli dev up` (or `npm run dev`), not
`vite`. It launches a managed browser that hosts the MCP command bridge.
`--no-open` starts the server with managed-browser launch disabled. Server status
and explicitly paired physical targets remain available. A targetless managed
browser command then fails with `browser_not_launched`; it never falls through
to a physical page. Commands default to the managed browser. One managed
window hosts the editor and application roles. Browser failure leaves Vite and
HMR running. `runtime status`, `runtime targets`, and `runtime wait` do not recover
or launch a browser; `runtime recover` explicitly retries after a failure.

Pair a headset using `runtime pair-headset --input-json '{"headsetId":"ADB_SERIAL"}'`,
open the returned URL on that exact device through ADB reverse, then copy its
`runtimeTarget` from `runtime targets`. Include deviceClass, headsetId, pageId, and
tabGeneration on every physical command. Reload is supported through the page
bridge; screenshot, snapshot, interaction, profiling, console capture, and the
managed editor are host-only. Rediscover after reload to get the new generation.

The developer owns whether that managed window is headed or headless. Do not
change modes silently: announce the change before restarting. In a visible
collaboration session, use the Runtime/Editor toggle in the single managed
Chromium window. Its expected unsupported-flag banner comes from
`--ignore-certificate-errors` for the local development certificate. Playwright
may add separate sandbox-related flags in constrained environments.

**`src/assets.ts`/`src/assets.js` is evaluated twice, in two different JS
realms** — once by the app runtime, once by the editor. It must be deterministic
and side-effect free: no `World`, no DOM, no timers, no reliance on shared object
identity.

**Static geometry lives in TypeScript, composition lives in JSON.** Scene JSON
never declares URLs, geometry or materials — only manifest IDs.

**Components must be declared in a system-free module** and exported from
`src/components.ts`/`src/components.js` via `defineComponents()`. The editor
imports that same manifest to build its inspector, so a component that is not in
it cannot be authored in scenes.

**Import Three.js from `@iwsdk/core`, never from `three`.** `@iwsdk/core`
re-exports all of Three; importing `three` directly creates a duplicate instance
and subtle breakage. Exception: `import type { GLTF } from 'three/addons/...'`.

## Traps that produce silent failures

| Trap                                                          | Symptom                                                                  | Fix                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `locomotion: true` with no `LocomotionEnvironment` on a floor | player falls through the world                                           | add the component to a walkable surface                                                  |
| Scene origin left occupied                                    | player spawns inside your geometry                                       | the player origin is `0,0,0` unless the scene authors `player.transform`                 |
| Scene JSON with `imports`                                     | authoring preview works, but editable open and runtime load are rejected | run `npx @iwsdk/cli scene flatten` once, then edit the flat output                       |
| `entity.destroy()`                                            | GPU memory leaked                                                        | use `entity.dispose()`                                                                   |
| `setValue` on a Vec2/Vec3/Vec4/Color field                    | throws in elics 3.4.x                                                    | use `entity.getVectorView(...)`                                                          |
| Environment component on a non-root entity                    | silently ignored                                                         | `DomeGradient`/`IBLGradient` go on the level root only                                   |
| Environment prop changed without `_needsUpdate`               | change ignored                                                           | set `_needsUpdate` after writing                                                         |
| `ScreenSpace` given numbers                                   | clamped with a console warning                                           | it takes CSS strings: `'400px'`, `'25vw'`                                                |
| `@iwsdk/reference` MCP tools in an old or `--no-install` app  | queries report warmup required                                           | run `npx @iwsdk/cli reference warmup`; fresh installed scaffolds do this during creation |

## Verify before you claim it works

**Always `npm run --if-present typecheck` before testing.** Type errors stop systems
initialising without necessarily logging anything in the browser.

For a new multi-file procedural model, finish the initial asset module and manifest
registration before any `npx @iwsdk/cli dev up`; do not keep the browser live while
its import graph is half-written. Typecheck first. Launching the managed editor is
not a default verification step — do it only when the user asks or a managed
session is already running; visual confirmation follows the gate below.

Then check the right status for the task — these are not interchangeable:

- scene/editor work → `scene_get_state`
- XR device or session actions → `xr_get_session_status`
- server readiness → `npx @iwsdk/cli dev status` (XR availability is not a server signal)

State questions are answered by named state, not by pictures: when something is
missing but the console is clean, read console logs without a level filter, then
query ECS (`ecs find` / `ecs query`) to confirm the entity exists and carries the
components you expect. A screenshot is never required for this.

The **editor** render does not run application systems, so a scene/editor
screenshot cannot prove system-driven behavior — but that does **not** make a
local runtime screenshot mandatory. Visual outcomes go through the gate below.

Pose, controller/hand alignment, and immersive interaction correctness can only
be experienced in an active XR session or on a real device; a flat desktop view
cannot prove them. Route them through the same deployed-site + human-device gate;
never claim them from a desktop screenshot.

### Visual verification gate — ask first, then deploy a versioned build

Visual outcomes (UI layout, text centering, touch gestures, camera feel, mobile
rendering) are **never** verified by driving the local managed browser, and no
screenshot is captured on the agent's own initiative. Whenever a task changes
anything visual, stop before verifying and ask the user exactly one question:

> Do you want to verify visually yourself, or should I verify it on the live site?

- **User verifies (human):** bump the patch version in `package.json`, run
  `npm run deploy`, and hand over
  `https://svalbardpost.xyz/games/harbor-defender/?v=<version>-<yyyymmddhhmmUTC>`
  together with exactly what to look at. Do no browser/screenshot check yourself;
  wait for the user's verdict.
- **Agent verifies:** bump the patch version identically, run `npm run deploy`,
  and drive **only the real deployed site** (trusted HTTPS) with browser
  automation at the same cache-busting URL. Never use localhost, the self-signed
  cert, the managed browser, `dev up`/`runtime recover`, or hand-rolled local
  static servers for verification.

Either way the build is versioned and deployed; the query string busts browser
and PWA caches. If an old service worker is served, one hard reload activates the
autoUpdate worker — note it, do not redeploy. The verification report must
include `package.json` version, short git SHA, and UTC timestamp, and must never
present visual/touch behavior as proven by typecheck or build alone.

### No local screenshot / visual-verification loops

Do not start the dev runtime or managed browser merely to capture screenshots.
If a session is already open and its bridge is unavailable
(`waiting_for_connection`, `browserCommandReady: false`), the sandbox blocks
Chromium, the automation browser is offscreen (`0x0`/`0x8` viewport), or a cert
interstitial appears, do not retry, restart, switch headed/headless mode, or
fight the certificate page — at most one diagnostic status check, then use the
gate above. This overrides screenshot / contact-sheet / preview-loop mandates in
project skills such as `iwsdk-ui`; those skills may not demand local visual
evidence.

The required non-visual gates are browser-free and always run:
`npm run typecheck`, then `npm run build` (or `npm run deploy`, which builds).

For a physical headset smoke test the user runs themselves, run
`npx @iwsdk/cli dev status`, open a URL from `data.runtimeUrls.network` on a
headset on the same Wi-Fi network, and accept the expected local certificate
warning. See
[Testing Your Experience](https://iwsdk.dev/guides/02-testing-experience.html)
for the complete workflow.

## MCP and CLI are one surface, not two

Nearly every capability exists both ways — `scene_render_file` and
`npx @iwsdk/cli scene render-file`, `ecs_find_entities` and `npx @iwsdk/cli ecs find`,
or `ui_inspect` and `npx @iwsdk/cli ui inspect`.
Discover CLI actions with the bare domain or domain help (`npx @iwsdk/cli scene` or
`npx @iwsdk/cli scene --help`); both list that domain's actions.

**CLI and MCP share the same target resolver and recovery policy.** A managed
command can recover a missing managed browser; it then returns
`browser_relaunched` with `outcome: "not_executed"`. Inspect the new state and issue
a fresh command. `outcome_unknown` means a dispatched mutation may have executed;
inspect state before retrying. Requests are never broadcast or replayed on
reconnect. Host browser tools can remain usable while a runtime bridge is loading.

Choose by the shape of the call, not by availability:

- **MCP** for one-off calls. Screenshot tools persist the PNG locally and return
  `screenshotPath`; they are not a verification step — use them only when the
  visual-verification gate above has selected agent verification against the
  deployed site, or when the user explicitly asks for a screenshot.
- **CLI** when you need to loop or script — rendering six views, or sampling a
  value twice to measure a rate — or when the response is big enough to be worth
  filtering before it reaches context. A render of a scene containing an
  instanced pattern returns an id for every expanded instance.

For screenshot-producing CLI commands, the default response writes the image to a
temporary file and returns a normal envelope with metadata under `data.result` and
the path at `data.screenshotPath`. `--output-file <path>` selects the destination and
keeps that same metadata, including hashes and render statistics. `--raw` instead
prints the raw runtime result, including base64 `imageData`; when both flags are
present, `--output-file` takes precedence and image bytes are omitted.

## Skills

Invoke `iwsdk-dev` first for any request that builds, extends, fixes, tunes,
or polishes the app. It privately selects the greenfield planner path or the
bounded established-app iteration path; do not look for those paths as separate
public skills.

The selected playbook routes work to the narrowest owning specialist:

- creating or materially changing one glTF or procedural 3D asset →
  `iwsdk-build-model`;
- arranging existing assets, scene JSON, cross-asset contacts, lighting,
  environment, or cameras → `iwsdk-compose-scene`;
- a mixed build → finish every new or changed model, including support and set assets,
  with `iwsdk-build-model`, then compose the scene with `iwsdk-compose-scene`;
- a model-local defect found during composition routes back to `iwsdk-build-model`;
  a placement or lighting defect stays in `iwsdk-compose-scene`.

UI authoring, physics, depth occlusion, grab and ray interaction testing, ECS
frame-stepping, and debugging have their own project skills. Use them only when
the selected `iwsdk-dev` playbook calls for the matching specialty.

The failure worth guarding against is improvising a domain that already has a
skill because the naive approach looks tractable. Before hand-authoring scene
JSON, a 3D model, a UIKitML panel, or a physics body, invoke the owning skill.

## Layout

```
iwsdk.config.json      project authority: scene, assets, components, world, dev
src/index.ts|js        World.create() + explicit system registration
src/assets.ts|js       defineAssets() — shared runtime/editor catalog
src/components.ts|js   defineComponents() — shared runtime/editor catalog
src/scene-assets/      *.scene-asset.ts|js — parentless Object3D prototypes
public/scenes/         *.iwsdk.scene.json — composition only
public/ui/             *.uikitml — runtime-loaded panels
```

No barrel `index.ts` files. Keep component declarations free of system, DOM and
renderer imports; systems import the declarations, never the reverse.

## Conventions

- Systems use queries, never manually tracked entity arrays.
- Never allocate in `update()`. Allocate in `init()` as class properties.
- Prefer `queries.x.subscribe('qualify', ...)` over polling state each frame.
- Register every subscription teardown in `this.cleanupFuncs`.
- Use `signal.peek()` in `update()`; `.value` adds per-frame subscription overhead.
- Load assets through `AssetManager` / the manifest, never a raw `GLTFLoader`.
- Create entities with `world.createTransformEntity(...)`, never `scene.add()`.
- Use the `RayInteractable` component, never a manual `Raycaster`.
- VR targets 72–90 fps: 11–14 ms per frame. Treat per-frame allocation as a bug.

## Deep reference

Harness-native scoped rules cover `public/scenes/**`, `public/ui/**`,
`src/assets.ts`, `src/scene-assets/**`, and `src/**/*.ts`. `AGENTS.md`-based
harnesses receive nested instruction files; Cursor and Copilot receive their
native rule formats. Skill procedures live in the selected harness's project
skill directory and state when they apply.
