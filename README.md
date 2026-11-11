# ask-user: interactive questions for pi

An OpenCode-style question dialog for [pi](https://github.com/earendil-works/pi). The model asks
questions through the `ask_user` tool instead of writing them into its reply, and you answer by
picking a suggested choice or by typing your own words — always available, for every question.

```
──────────────────────────────────────────────────────────────────────────────────
 Answer questions                                     Question 1 of 2
   □ Naming scheme   □ Scope   ✓ Submit

 How should renamed photos be named?

> 1. Date-based (Recommended)
     2023-05-14_153022.jpg from EXIF, falling back to file mtime
  2. Sequential counter
     photo_0001.jpg, numbered in sort order
  3. Location + date
     Paris_2023-05-14_001.jpg, using GPS/XMP place when present
  4. Write my own answer

 up/down move • enter select • 4 write your own • Tab/←→ switch question • escape cancel
──────────────────────────────────────────────────────────────────────────────────
```

## Install

Install it as a package from this repository, and pi keeps the code — and every word of its
model-facing prompt text — in step with the remote:

```bash
pi install git:github.com/kurikaesu/pi-questions
pi list                   # show configured packages
pi update --extensions    # reconcile now instead of at next start
```

That writes one line into `~/.pi/agent/settings.json`, which is the only thing to reproduce on a new
machine. pi clones the source, reads `pi.extensions` from `package.json`, and on every start and
`/reload` fetches and resets to the remote branch, so a fresh computer runs what the remote holds.
The rules text lives inside `ask-user.ts` (see [Prompt text](#prompt-text)), so one clone installs
the tool *and* the system-prompt rules it depends on — there is no second file to remember.
`pi update git:github.com/kurikaesu/pi-questions` refreshes just this package, and
`pi remove git:github.com/kurikaesu/pi-questions` undoes the install.

Pin a ref with `git:github.com/kurikaesu/pi-questions@v1.0.0` if you would rather it stop tracking
the branch tip; `pi update --extensions` still reconciles the checkout but does not move a
configured ref.

Other ways to run it:

| | |
|---|---|
| package install (above) | follows the remote, prompts included |
| `pi -e ask-user.ts` | one launch only, cached under `~/.pi/agent/tmp/extensions/` |
| symlink into `~/.pi/agent/extensions/` | follows the clone; as fresh as your last `git pull` |
| `cp` into `~/.pi/agent/extensions/` | frozen at copy time, silently |

A copied file is the one to avoid: nothing updates it, so a new machine — or this one in three
months — can be running an older `<ask_user>` rules block with no signal anywhere. If you do copy
it, re-copy on every change; `/reload` picks up a file that has changed in place.

Global extensions and package installs are available in every project and need no per-project trust.
To scope it to one project instead, put it in that project's `.pi/extensions/ask-user.ts`, which
loads once the project is trusted (pi asks on first run, or pass `--approve`). Keep it in only one
location, otherwise `ask_user` registers twice.

Confirm what a machine is actually running by hashing the loaded file against the repo:

```bash
shasum -a 256 ask-user.ts
find ~/.pi/agent -name ask-user.ts -not -path '*/sessions/*' -print0 | xargs -0 shasum -a 256
```

Matching hashes mean that machine is running the copy you have checked out.

## The tool

| | |
|---|---|
| Name | `ask_user` |
| Input | `questions: [{ question, header?, choices?: [{ label, description? }] }]` |
| Limits | 1–4 questions per call, 0–3 choices per question |
| UI | one tab per question plus a review/submit tab; each question ends with `Write my own answer` |

Keys: `↑`/`↓` move, `Enter` select, `1`…`n` pick a choice, `n+1` opens the free-text entry,
`Tab`/`←`/`→` switch question, `Esc` cancel (`Esc` inside the text entry only steps back to the
choices). Answering the last question lands you on the review tab; `Enter` submits. A single
question submits as soon as you answer it.

Answers come back to the model as explicit provenance, so it knows whether you took its
suggestion or overrode it:

```
The user answered 2 questions:

1. Q (Theme): Which colour scheme should the example use?
   choices: 1) Dark, 2) Light, 3) Follow terminal
   A: Follow terminal (user chose choice 3 of 3)
2. Q (Notes): Anything else the example should know?
   choices: open question (no suggested choices)
   A: use tokens please (user wrote their own answer)
```

Cancelling with `Esc` tells the model to stop asking and either take the safest assumption and
state it, or report that it is blocked — so a dismissal never loops.

## How the model is forced to use it

Three layers, from softest to hardest:

1. **Tool declaration** — `promptSnippet` and `promptGuidelines` put `ask_user` in the
   `<tools>` and `<rules>` sections of pi's default system prompt.
2. **`<ask_user>` prompt section** — every run adds a dedicated rules section (via
   `before_agent_start`) that spells out: never ask in prose, batch related questions into one
   call, up to 3 choices, never add an "Other" choice yourself, ask before doing the work.
   It is added as a named section, so pi patches it into the cached prompt once instead of
   rewriting the whole prompt per run.
3. **The prose-question gate** — a `turn_end` handler inspects any final reply that ends with no
   tool calls. If its tail looks like a question or an input request ("Should I…", "Which one do
   you prefer?", "Tell me which…", "Ready to submit?" …), the turn is not allowed to settle: the
   extension appends a hidden `custom_message` telling the model to call `ask_user` instead, asks
   pi for one more provider request (`continue: true`), and shows a notify line so you can see why
   the answer changed shape. It fires at most once per run, and never after you cancel a dialog.

Toggle the gate with `/ask-user off` (per session; the choice is persisted as a session entry and
restored on resume, `/reload`, and `/tree` navigation).

## Prompt text

Everything this extension tells the model is in `ask-user.ts`, next to the code that acts on it:

| Constant | Where it lands |
|---|---|
| `ASK_RULES_SECTION` | `options.sections.ask_user`, a named section patched into the system prompt each run |
| `TOOL_GUIDELINES` | `<rules>` entries for the tool, via `promptGuidelines` |
| the tool `description` and `promptSnippet` | `<tools>` list line and tool schema description |
| `NUDGE_TEXT` | hidden `custom_message` sent when a prose question gets bounced |
| `CANCEL_TEXT` / `UNAVAILABLE_TEXT` | tool results for a dismissed dialog and a non-interactive run |

There is deliberately no separate prompt template, skill, or `AGENTS.md` fragment to install: the
`pi.extensions` entry loads the one file, and the file carries its own rules. Installing the package
on a new machine therefore cannot half-install — you get the tool and the instructions that make it
behave, or neither. `npm test` asserts the section is injected as a patchable named section and that
it still contains the rules the gate assumes (see [Test](#test)).

## Commands

| Command | |
|---|---|
| `/ask-user status` | report whether the gate is on |
| `/ask-user on` / `/ask-user off` | toggle the prose-question gate |
| `/ask-user demo` | open the dialog with sample questions, no model involved |

## Non-interactive runs

* `--mode rpc`: each question becomes a native `select` dialog, with a text `input` dialog when
  you choose "Write my own answer".
* `-p` / `--mode json`: prompting is impossible, so the tool returns "make the safest reasonable
  choice yourself and state the assumption" and the gate stays off. This keeps scripted runs from
  hanging or looping.

## Detection tuning

The gate's heuristics live in two clearly-marked arrays at the top of the "Prose-question
detection" section: `QUESTION_PATTERNS` (need a `?` in the reply tail) and
`INPUT_REQUEST_PATTERNS` (imperative requests for input, no `?` required). Add phrases there if
your model has a favourite way of smuggling a question into prose. A false positive costs one
extra model turn, not a wrong answer.

## Test

```bash
npm test        # node test/run.mjs
```

`test/run.mjs` loads the extension with jiti (pi's own TypeScript loader), hands it a stand-in
`ExtensionAPI`, and drives it without a model or a terminal: prompt-section injection, the tool
declaration, real keystrokes through the panel (`↑`/`↓`, digits, `n+1`, `Tab`/`←`/`→`, `Esc`,
`Ctrl-C`), review-tab submission, free-text answers, normalisation caps, the rpc and print fallbacks,
every gate branch and its `/ask-user` toggles, and both renderers. It needs the `pi` binary on
`PATH`, or `PI_ROOT` pointing at a `pi-coding-agent` package directory.

## Notes

* The tool is registered `executionMode: "sequential"`, so two dialogs can never stack.
* Everything renders within the supplied terminal width using pi's `visibleWidth`,
  `wrapTextWithAnsi`, and `truncateToWidth` helpers, and reports pi as blocked on user input to
  terminals that support program status.
* Key hints in the footer line come from your own keybinding configuration.

## License

GPL-3.0-only, see [LICENSE](LICENSE).
