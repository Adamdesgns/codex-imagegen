---
name: codex-imagegen
description: Generate a still image (character reference, storyboard frame, illustration, concept art, product shot) with the user's own ChatGPT account through the OpenAI Codex CLI, with no browser and no API key. Use whenever the user wants an image or picture made, a still generated, a character reference, a storyboard frame, concept art or a product shot, or says to use ChatGPT or Codex to make an image.
---

# codex-imagegen

This skill makes one still image per run. It uses the user's own ChatGPT account through the Codex CLI's built-in image tool. The helper script does the work: `scripts/imagegen.mjs`, inside this skill's base directory (the base directory is shown when the skill loads).

Run the script with `node`. Never run `codex` by hand for this.

## Steps

1. **Write the prompt to a `.txt` file** next to where the image will live (for example `images/hero-prompt.txt`). Plain English, one subject. Include:
   - the subject and setting, the light, the lens or art style
   - the aspect ratio in words: "vertical 9:16", "wide 16:9", "square"
   - what must NOT appear
   - "an original person, not anyone real" for any human
   - "no text, no logos, no watermark" unless the user wants text. Warn the user that generated text is often misspelled.

2. **Run the script** with a Bash timeout of 600000 ms (10 minutes) and `--timeout-sec 540`, so the script always gives up, stops Codex and cleans up before the Bash tool would cut it off. A normal run takes about 40 seconds.

   ```
   node "<skill base dir>/scripts/imagegen.mjs" --prompt-file images/hero-prompt.txt --out images/hero-v1.png --log images/SOURCES.md --timeout-sec 540
   ```

   First image of the session, or after any failure: run `node "<skill base dir>/scripts/imagegen.mjs" --doctor` first. It checks Codex, the sign-in, and Node.

3. **Keep characters consistent.** Pass each earlier approved image with `--image`, once per file: `--image images/hero-v1.png --image images/side-v1.png`. Say in the prompt what to keep ("same face, same jacket") and what changes.

4. **Look at the image yourself** before showing it. Open the output file with the Read tool and check it against the prompt: count the people, look for stray text, logos or extra limbs, and check the aspect ratio against the width and height in the script's JSON. Tell the user what you checked and what you found.

5. **Show the user and ask for approval before making the next image.** Never overwrite: the script saves `name-2.png`, `name-3.png` if a name is taken, and the JSON `out` field is the real path. Keep every version. For a retry, name the new file `hero-v2.png`.

6. **Read the script's one-line JSON on stdout.** Success is `{"ok":true,"out":...,"width":...,"height":...}`. Sizes vary, so trust the reported size. If it also has `log_error`, the image is saved but the `--log` file could not be written: tell the user. Otherwise `{"ok":false,"code":N,"error":...,"hint":...}`:

   | Exit | Meaning | What to do |
   |---|---|---|
   | 1 | bad arguments | fix the command (missing `--out`, a folder that cannot be written, a bad `--log`). If the JSON has a `source` field, the image WAS made and is safe at that path: copy it, do not generate again. |
   | 2 | Codex not found | tell the user to install Codex (npm package or desktop app) and sign in; see the README. They can also pass `--codex PATH` or set `CODEX_BIN`. |
   | 3 | Codex failed or signed out | ask the user to sign in using the exact command in `hint` (with the Codex desktop app there is no `codex` on PATH, so the hint gives the full path, or they can sign in inside the app), then run `--doctor`. A usage-limit message means wait. An `Unexpected error` message is a bug in the script, not a sign-in problem: do not send the user to log in, report it. |
   | 4 | no image produced | Codex may have refused the prompt. Report Codex's message from `error` to the user. Do not retry blindly: change one thing in the prompt, then run again. If Codex says it cannot generate images (an old Codex, or a plan without image generation), changing the prompt will not help: tell the user to update Codex or check their ChatGPT plan. |
   | 5 | timed out | try once more, or raise `--timeout-sec` (and the Bash timeout with it). |

   Change one thing per retry, so you know what fixed it.

## Rules

- Prompts and reference images are sent to OpenAI under the user's own ChatGPT account. So is the user's global Codex instructions file (`~/.codex/AGENTS.md`, if they have one): Codex loads it into every session, even though the script skips `config.toml`. Never send an image of a real person without that person's consent, and never ask for an image of a real, named person.
- `--log` appends the prompt, Codex version, thread and timing to a markdown file. Use it so every image can be traced back to its prompt.
- Do not pass `--use-user-config` unless the user asks. It brings back the MCP servers and tools in their `config.toml`, which the read-only sandbox does not cover.
- One image per run. For a set (a storyboard, a character sheet), run the script once per frame, in order, with approval between frames.
