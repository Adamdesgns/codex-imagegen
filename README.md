# codex-imagegen

A Claude Code plugin that makes still images with **your own ChatGPT account**, through the image generation tool built into the OpenAI Codex CLI. No browser, no API key.

Use it for character references, storyboard frames, illustrations, concept art and product shots. You ask Claude for an image; Claude writes a prompt file, runs a small script, looks at the result, and shows it to you.

## Prerequisites

- **Claude Code**.
- **Node.js 18 or newer** (the script has no dependencies).
- **The OpenAI Codex CLI, signed in with ChatGPT.** A recent version: it was tested with codex-cli 0.159.2.
  - Install it with `npm install -g @openai/codex`, or install the Codex desktop app.
  - Sign in once: run `codex login` in your own terminal and choose Sign in with ChatGPT.
  - If you only have the Codex desktop app (the Microsoft Store app on Windows, or Codex.app on a Mac), there is no `codex` on your PATH. Sign in inside the app, or run the full path that `--doctor` prints, followed by `login`. The script finds the app's CLI for you.
  - Check: `node skills/codex-imagegen/scripts/imagegen.mjs --doctor` shows the Codex it found and whether you are signed in.
- **A ChatGPT plan that includes Codex image generation.** Image generation uses your account's Codex allowance. If your plan or your Codex version has no image tool, Codex will say so and no image is made. Check OpenAI's current plan terms for limits.

## Install

From inside Claude Code:

```
/plugin marketplace add Adamdesgns/codex-imagegen
/plugin install codex-imagegen@codex-imagegen
```

To test a local copy without installing it:

```
claude --plugin-dir /path/to/codex-imagegen
```

To check the manifests: `claude plugin validate /path/to/codex-imagegen` (the marketplace manifest) and `claude plugin validate /path/to/codex-imagegen/.claude-plugin/plugin.json` (the plugin manifest). Validate does not read `SKILL.md`. To see that the skill really loads, run `claude --plugin-dir /path/to/codex-imagegen plugin details codex-imagegen`, which should list `Skills (1)  codex-imagegen`. `npm test` also checks the `SKILL.md` frontmatter.

## Use

Just ask Claude:

> Make a character reference of an original astronaut, vertical 9:16, with Codex.

Claude should write the prompt to a `.txt` file, run the script, open the image to check it against your request, and ask you to approve it before making the next one. Approved images can be passed back as references so the next frame keeps the same character.

You can also run the script yourself. Paths below are relative to the plugin folder.

```bash
# one image from a prompt
node skills/codex-imagegen/scripts/imagegen.mjs \
  --prompt "A small blue ceramic mug on a white table, soft window light, square" \
  --out images/mug.png --log images/SOURCES.md

# next storyboard frame, same character: attach earlier images (one --image per file)
node skills/codex-imagegen/scripts/imagegen.mjs \
  --prompt-file frames/frame-02.txt --out frames/frame-02.png \
  --image frames/frame-01.png --image refs/character.png

# check Codex, sign-in, CODEX_HOME and Node
node skills/codex-imagegen/scripts/imagegen.mjs --doctor
```

On success the script prints one line of JSON on stdout (progress goes to stderr):

```json
{"ok":true,"out":"images/mug.png","width":1024,"height":1024,"seconds":38.2,"thread_id":"...","codex_version":"0.159.2","source":"..."}
```

`out` is the real saved path. If `images/mug.png` already exists the script never overwrites it: it saves `mug-2.png`, `mug-3.png` and so on and reports the new name.

### Options

| Option | What it does |
|---|---|
| `--prompt TEXT` / `--prompt-file FILE` | The image prompt (one of the two). A prompt file can be UTF-8 or UTF-16 with a BOM (what Windows PowerShell writes with `>`). |
| `--out FILE` | Where to save. If the extension does not match the real image format, the real one is used. The folder is checked before Codex starts, so a bad path costs nothing. |
| `--image FILE` | Reference image. Repeat for several. Each is copied into the temp folder as `ref-1.png`, `ref-2.png` ..., so commas and odd characters in your path cannot break it. |
| `--log FILE` | Append a markdown entry (time, file, Codex version, thread, references, seconds, full prompt). Earlier entries are never rewritten. |
| `--codex PATH` | Codex executable, or a `.js`/`.mjs` launcher. Same as env `CODEX_BIN`. |
| `--timeout-sec N` | Stop Codex after N seconds, from 1 to 2147483. Default 600. The clock starts when Codex starts. If your own tool kills commands after 10 minutes, pass `--timeout-sec 540` so the script stops Codex and cleans up first (the Claude skill does this). |
| `--use-user-config` | Let Codex read your `config.toml`. Default is to skip it. **This also brings back every MCP server and tool in that file. They run outside Codex's command sandbox, so use it only if you trust everything configured there.** |
| `--keep-session` | Keep the Codex session on disk. Default is ephemeral. |
| `--doctor` | Print Codex path, version, sign-in status, `CODEX_HOME` and Node version. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Image saved. |
| 1 | Bad arguments: a reference image that does not exist, a prompt file that is not UTF-8, an `--out` or `--log` path that cannot be written. If the failure has a `source` field, Codex DID make the image and it is safe at that path; copy it, do not run again. |
| 2 | Codex not found. |
| 3 | Codex failed, or you are not signed in. |
| 4 | Codex finished but produced no image (it may have refused the prompt). |
| 5 | Timed out; Codex was stopped. |

Failures print `{"ok":false,"code":N,"error":"...","hint":"..."}`. If the image was saved but the `--log` file could not be written, the run still succeeds and the JSON has an extra `log_error` field. An error starting `Unexpected error` is a bug in this script, not a sign-in problem.

## No plugin? Paste a prompt instead

The plugin is the reliable route: the script finds Codex, turns off its other tools, never overwrites, and reports the real size. If you would rather not install anything, paste the prompt below into Claude Code (or another coding agent that can run commands) and describe your image on the last line. The agent does the same steps by hand, so expect it to need a try or two, and it will not have the script's safety checks.

```text
Make one image with my ChatGPT account through the OpenAI Codex CLI. No browser, no API key.

1. Find Codex. Use `codex` if it is on PATH. On Windows with only the Codex desktop app, the CLI is <InstallLocation>\app\resources\codex.exe, where InstallLocation comes from: powershell -NoProfile -Command "(Get-AppxPackage OpenAI.Codex).InstallLocation". On a Mac with only Codex.app it is /Applications/Codex.app/Contents/Resources/codex. Run `<codex> login status` and stop if I am not signed in.
2. Write my image prompt to a .txt file next to where the image will be saved. Include the shape in words (for example "vertical 9:16"), "an original person, not anyone real" if there are people, and "no text" unless I asked for text.
3. Make an empty temp folder and work from inside it. If I gave reference images, copy them in as ref-1.png, ref-2.png and so on (Codex splits --image values on commas, so never pass my original paths).
4. Run this with no shell wrapper, piping the task text on stdin, and allow up to 10 minutes:
   <codex> exec --skip-git-repo-check --ignore-user-config --ephemeral --json -s read-only -c features.shell_tool=false -C <temp folder> [--image=ref-1.png ...]
   The task text is: "Use your built-in image generation tool exactly once to generate this image. Do not run shell commands and do not edit any files. When it is done, reply with only the full file path of the saved image." then a blank line, then "IMAGE PROMPT:" and the prompt file's contents. With reference images, add "using the attached image as the reference for the same person and place" after "generate this image".
5. Read thread_id from the first JSON line on stdout ({"type":"thread.started","thread_id":"..."}). The image is the newest file in ~/.codex/generated_images/<thread_id>/ (or $CODEX_HOME/generated_images/<thread_id>/). Copy it next to the prompt file. Never overwrite: if the name is taken, add -2, -3 and so on. Delete the temp folder.
6. Open the image and check it against the prompt: count the people, look for stray text or logos, and check the shape. Tell me what you checked, show me the image, and wait for my OK before making another.

My image: <describe it here>
```

## How it works

1. Finds Codex: `--codex`, then `CODEX_BIN`, then `codex` on PATH (`codex.exe`, or the npm `codex.cmd` shim, on Windows), then the Windows Store app (`Get-AppxPackage OpenAI.Codex`), then `/Applications/Codex.app` on macOS.
2. Wraps your prompt in a short task: use the built-in image tool exactly once, run no shell commands, edit no files, reply with the saved path.
3. Runs `codex exec --skip-git-repo-check --ignore-user-config --ephemeral --json -s read-only -c features.shell_tool=false ... -C <fresh temp dir> -o <file>` with the task on stdin. No shell is involved on this side, and the temp dir is deleted afterwards. `-s read-only` only stops commands from writing; a command could still read any file you can. So the script also turns off Codex's command tool and its computer-use, browser, apps, plugins and multi-agent features (`-c features.NAME=false`). The prompt's "run no shell commands" is a second line of defence, not the only one. (Codex drives its image tool through a small `exec` tool that runs JavaScript in an isolated sandbox with no file system, network or shell of its own. That one stays on, because the image is made through it.) Reference images are copied into the temp dir and attached as `--image=FILE`.
4. Reads Codex's JSONL events for the thread id. Codex's image tool writes the picture to `<CODEX_HOME>/generated_images/<thread id>/` (`CODEX_HOME` defaults to `~/.codex`). The script trusts that file on disk, not the chat message, and falls back to a path in the final message only if the file was written during this run.
5. Copies the file to `--out`, reads the real width and height from its header (PNG, JPEG, WebP), and appends to the log if asked.

## Privacy

- Your prompt text and any reference images are sent to OpenAI through Codex, under your own ChatGPT account. This plugin has no server, no telemetry and no API key. It never reads Codex's sign-in files.
- Never send a photo of a real person without their consent, and do not ask for images of real, named people. Prompts say "an original person, not anyone real" for that reason.
- The `--log` file holds your full prompts. Keep it out of public repos if the prompts are private.
- `--ignore-user-config` skips `config.toml` and the MCP servers in it, but nothing else. **Codex still loads your global instructions file (`$CODEX_HOME/AGENTS.md` or `AGENTS.override.md`, `~/.codex/AGENTS.md` by default) into every session, so its contents go to OpenAI with each image request.** (This follows from Codex's source: the flag only blanks the config.toml layer.) Keep that file free of anything you do not want sent.
- `--use-user-config` re-enables the MCP servers and tools in your `config.toml`. They are separate programs outside the read-only sandbox, so a run with that flag can do far more than the default run. Use it only if you trust everything configured there.

## Troubleshooting

- **Exit 2, Codex not found.** Run `--doctor`. Install Codex (see Prerequisites), or pass `--codex /full/path/to/codex` or set `CODEX_BIN`. A `codex.cmd` on PATH that the script cannot trace (npm, pnpm and Yarn shims are understood) is skipped in favour of the Store app or Codex.app; if nothing else is found, point `--codex` at `codex.exe` or at `node_modules/@openai/codex/bin/codex.js`.
- **Exit 3, not signed in.** Run the sign-in command the `hint` gives you in your own terminal (it opens a browser), then `--doctor`. With the Codex desktop app there is no `codex` on PATH, so the hint (and `--doctor`) show the full path to run followed by `login`; signing in inside the app works too. A usage or rate limit message means wait and try again later.
- **Exit 4, no image.** Read the `error` field: it is Codex's own final message, often a content policy refusal. Change one thing in the prompt and try again; retrying the same prompt rarely helps. If Codex says it cannot generate images, the prompt is not the problem: update Codex (`npm install -g @openai/codex`) and check that your ChatGPT plan includes Codex image generation.
- **Exit 5, timeout.** Try again, or raise `--timeout-sec`.
- **Exit 1 with a `source` field.** The image was made but could not be copied to `--out`. Copy it from `source` yourself; do not run again, that spends another generation.
- **A reference image seems ignored.** Codex silently drops an `--image` file it cannot open, so the script checks every path first and exits 1 if one is missing. Codex also splits an `--image` value on commas, which is why the script attaches copies named `ref-1.png`, `ref-2.png`.
- **Wrong shape.** Output size is not fixed (a 9:16 request came back 941x1672 in testing). Say the shape in words, such as "vertical 9:16", and read `width`/`height` from the JSON.

## Limits

- One image per run, about 40 seconds in the test below; busy times can take minutes.
- Text inside images is often misspelled. Ask for none unless you need it.
- Likeness across images is approximate, even with references.
- Relies on Codex's built-in image tool and on Codex's `-c features.NAME=false` switches, which OpenAI can change (a switch a future Codex no longer knows is ignored, so check `codex features list` after a big Codex update). Tested on Windows 11 with codex-cli 0.159.2. The macOS and Linux code paths are covered by the stub-based tests but have not been run against a real Codex.

## Development

```
npm test        # same as: node --test
```

The tests use a stub Codex (`test/stub-codex.mjs`) that mimics Codex's JSONL events and writes a real PNG into a fake `CODEX_HOME`. They never call the real Codex or your account. The stub can also hang (with a child process, to prove the whole tree is killed), split a multi-byte character across two writes, and break the `--out` or `--log` path after it has made the image.

```
.claude-plugin/plugin.json        plugin manifest
.claude-plugin/marketplace.json   single-plugin marketplace (repo root is the plugin)
skills/codex-imagegen/SKILL.md    the instructions Claude follows
skills/codex-imagegen/scripts/imagegen.mjs   the script (Node 18+, no dependencies)
test/                             node:test suite and the stub Codex
```

## License

MIT. Copyright (c) 2026 Adamdesgns.
