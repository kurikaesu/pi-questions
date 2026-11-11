import { execSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Drives ask-user.ts outside Pi with jiti — the same TypeScript loader Pi uses — through a
 * stand-in ExtensionAPI: real prompt injection, real keystrokes, real answer formatting.
 * No model calls, no terminal, nothing written to ~/.pi.
 *
 *   node test/run.mjs
 *   PI_ROOT=/path/to/pi-coding-agent node test/run.mjs
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function findPiPackage() {
	if (process.env.PI_ROOT) return process.env.PI_ROOT;
	const binary = fs.realpathSync(execSync("command -v pi", { shell: "/bin/bash", encoding: "utf8" }).trim());
	let dir = dirname(binary);
	for (let depth = 0; depth < 10; depth++) {
		for (const candidate of [join(dir, "node_modules"), join(dir, "lib", "node_modules"), join(dir, "libexec", "lib", "node_modules")]) {
			const pkg = join(candidate, "@earendil-works", "pi-coding-agent");
			if (fs.existsSync(join(pkg, "package.json")) && fs.existsSync(join(pkg, "node_modules", "jiti"))) return pkg;
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	throw new Error("could not locate the Pi installation; set PI_ROOT to its pi-coding-agent package directory");
}

const ROOT = join(findPiPackage(), "node_modules");
const { createJiti } = await import(pathToFileURL(join(ROOT, "jiti", "lib", "jiti.mjs")).href);

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-ai": `${ROOT}/@earendil-works/pi-ai`,
		"@earendil-works/pi-tui": `${ROOT}/@earendil-works/pi-tui`,
		typebox: `${ROOT}/typebox/build/index.mjs`,
	},
});

const mod = await jiti.import(resolve(HERE, "..", "ask-user.ts"));
const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");

// ---------- stand-ins ----------

// Real terminal byte sequences, so the panel's own matchesKey() logic is what gets tested.
const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	shiftTab: "\x1b[Z",
	escape: "\x1b",
	enter: "\r",
	ctrlC: "\x03",
};

const strip = (line) => String(line).replace(/\u001b\[[0-9;]*m/g, "");
const fakeTheme = () => ({ fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text, style: (_token, text) => text, colors: {}, appearance: "dark" });
const fakeKeybindings = { matches: () => false, getKeys: () => [] };
const fakeTui = { requestRender() {} };

/** Fresh extension instance: the closure state (gate flags, nudge latch) starts clean every time. */
function load({ active = ["ask_user"] } = {}) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const entries = [];
	const activeTools = [...active];
	const pi = {
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		appendEntry(customType, data) {
			entries.push({ type: "custom", customType, data });
		},
		setActiveTools(next) {
			activeTools.length = 0;
			activeTools.push(...next);
		},
		getActiveTools: () => [...activeTools],
	};
	mod.default(pi);

	function ctxFor({ mode = "tui", hasUI = true, branch = [], custom, select, input } = {}) {
		const notify = [];
		return {
			mode,
			hasUI,
			cwd: process.cwd(),
			sessionManager: { getBranch: () => branch },
			ui: { theme: fakeTheme(), notify: (text, kind) => notify.push([kind, text]), setStatus() {}, custom, select, input },
			notifyCalls: notify,
		};
	}

	return { handlers, tools, commands, entries, ctxFor };
}

/** Captures the interactive panel so a test can press keys and read what it renders. */
function panelHost() {
	const captured = { component: undefined, options: undefined };
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: fakeTheme(),
			notify: () => {},
			setStatus() {},
			custom(factory, options) {
				captured.options = options;
				return new Promise((resolveAnswer) => {
					captured.component = factory(fakeTui, fakeTheme(), fakeKeybindings, resolveAnswer);
					captured.component.focused = true;
				});
			},
		},
	};
	return { ctx, captured };
}

/** Panel lines with the colour codes removed. Takes a panelHost() result or its raw capture. */
const panelOf = (target) => target?.captured ?? target;
const view = (target, width = 78) => {
	const lines = panelOf(target).component.render(width).map(strip);
	return Object.assign(lines, { text: lines.join("\n") });
};

const press = async (target, ...keys) => {
	const panel = panelOf(target).component;
	for (const key of keys) {
		panel.handleInput(key);
		await null;
	}
};

const typed = (text) => [...text].map((character) => character);
const toolText = (result) => (result.content ?? []).map((block) => block.text ?? "").join("\n");
const check = (label, condition, extra = "") => {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : `\n${extra}`}`);
	if (!condition) process.exitCode = 1;
};

// ---------- registration ----------

const reg = load();
const tool = reg.tools.get("ask_user");
check("ask_user tool registered", tool !== undefined, [...reg.tools.keys()].join(","));
check("/ask-user command registered", reg.commands.get("ask-user") !== undefined, [...reg.commands.keys()].join(","));
check(
	"hooks wired: start, tree, agent_start, prompt, gate",
	["session_start", "session_tree", "agent_start", "before_agent_start", "turn_end"].every((event) => (reg.handlers.get(event) ?? []).length === 1),
	[...reg.handlers.keys()].join(","),
);
check("tool runs sequentially so dialogs cannot stack", tool.executionMode === "sequential", String(tool.executionMode));
check("tool description forbids prose questions", /ONLY way to ask/.test(tool.description) && /Do not add an "Other"/.test(tool.description), tool.description);
check("promptSnippet advertises the tool", /Ask the user questions interactively/.test(tool.promptSnippet ?? ""), String(tool.promptSnippet));
check("promptGuidelines carry the usage rules", (tool.promptGuidelines ?? []).length === 4 && tool.promptGuidelines.every((line) => /ask_user/.test(line)), JSON.stringify(tool.promptGuidelines));
check("schema declares a questions array", tool.parameters?.properties?.questions?.type === "array", JSON.stringify(tool.parameters?.properties?.questions));
check("schema requires question text", tool.parameters.properties.questions.items.required?.includes("question") === true, JSON.stringify(tool.parameters.properties.questions.items));

// ---------- system prompt section ----------

const promptEvent = { systemPromptOptions: {} };
const promptReturn = await reg.handlers.get("before_agent_start")[0](promptEvent, reg.ctxFor());
const section = promptEvent.systemPromptOptions.sections?.ask_user;
check("prompt section injected as a named section", typeof section === "string" && section.length > 400, typeof section);
check("prompt is patched, not forced", promptReturn === undefined && promptEvent.systemPrompt === undefined, JSON.stringify(promptReturn));
check("section forbids prose questions", /you MUST call ask_user/.test(section) && /Never put the question only in your reply text/.test(section));
check("section bans the usual prose sign-offs", /Never end a turn with prose questions/.test(section) && /Which one do you prefer/.test(section));
check("section caps choices at 3 and forbids adding Other", /1-3 concrete choices/.test(section) && /never add "Other", "Custom", or "Something else"/.test(section));
check("section says one batched call, ask before the work", /ONE ask_user call/.test(section) && /Ask before doing work that depends on the answer/.test(section));
check("section tells the model to stop on cancel", /If the user cancels the dialog, stop asking/.test(section));
check("section keeps the own-answer promise", /permanent "Write my own answer" entry/.test(section));

const inactiveEvent = { systemPromptOptions: {} };
await load({ active: [] }).handlers.get("before_agent_start")[0](inactiveEvent, load().ctxFor());
check("section skipped when the tool is not active", inactiveEvent.systemPromptOptions.sections === undefined, JSON.stringify(inactiveEvent));

// ---------- panel: one question, a chosen answer ----------

{
	const host = panelHost();
	const running = tool.execute(
		"tc1",
		{ questions: [{ question: "Which licence should the repo carry?", header: "Licence", choices: [{ label: "GPL-3.0-only" }, { label: "MIT" }] }] },
		undefined,
		undefined,
		host.ctx,
	);
	await null;
	const screen = view(host);
	check("panel reports that pi is blocked on the user", panelOf(host).options?.blocked?.kind === "question", JSON.stringify(panelOf(host).options));
	check("panel renders a framed box", screen.length > 6 && screen[0].startsWith("─") && screen.at(-1).startsWith("─"), screen.text);
	check("a lone question hides the tab bar", !screen.text.includes("Submit"), screen.text);
	check("own-answer entry is always offered", screen.text.includes("Write my own answer"), screen.text);
	check("footer hint names the free-text key", /3 write your own/.test(screen.text), screen.text);
	check("lines fit the supplied width", screen.every((line) => visibleWidth(line) <= 78), screen.text);
	check("narrow terminals wrap inside the width", view(host, 24).every((line) => visibleWidth(line) <= 24), view(host, 24).text);

	await press(host, KEYS.down);
	check("down moves the selection", view(host).some((line) => line.startsWith("> 2.")), view(host).text);
	await press(host, KEYS.up, KEYS.up);
	check("selection clamps at the first choice", view(host).some((line) => line.startsWith("> 1.")), view(host).text);
	await press(host, KEYS.enter);
	const single = await running;
	check("one question submits as soon as it is answered", toolText(single).startsWith("The user answered 1 question:"), toolText(single));
	check("answer reports which option was taken", /\(user chose choice 1 of 2\)/.test(toolText(single)) && /GPL-3\.0-only/.test(toolText(single)), toolText(single));
	check("result tells the model these are real instructions", /Use these answers as the user's actual instructions/.test(toolText(single)));
	check("details carry the answer for the renderer", single.details.cancelled === false && single.details.answers[0].kind === "choice", JSON.stringify(single.details));
}

// ---------- panel: several questions, free text, review, submit ----------

{
	const host = panelHost();
	const questions = [
		{ question: "How should the install section read?", header: "Install", choices: [{ label: "Package" }, { label: "Symlink" }, { label: "Copy" }] },
		{ question: "Anything else the docs should mention?", header: "Notes", choices: [] },
	];
	const running = tool.execute("tc2", { questions }, undefined, undefined, host.ctx);
	await null;
	check("tab bar shows both questions plus submit", /Install/.test(view(host)[2]) && /Notes/.test(view(host)[2]) && /Submit/.test(view(host)[2]), view(host)[2]);

	await press(host, KEYS.right);
	check("Tab walks to the second question", /Question 2 of 2/.test(view(host)[1]), view(host).text);
	check("a question with no suggested choices opens free text", /Your answer/.test(view(host).text), view(host).text);

	await press(host, ...typed("half typed"), KEYS.escape);
	check("escape in the text entry steps back out of typing", !/Your answer/.test(view(host).text) && /yours to answer freely/.test(view(host).text), view(host).text);
	check("the half-typed answer is not kept on screen", !view(host).text.includes("half typed"), view(host).text);

	await press(host, KEYS.enter);
	check("Enter on a choice-less question reopens the text entry", /Your answer/.test(view(host).text), view(host).text);
	await press(host, ...typed("symlinks please"), KEYS.enter);
	check("submitting a free-text answer walks back to the first gap", /Question 1 of 2/.test(view(host)[1]), view(host).text);

	await press(host, KEYS.left);
	const review = view(host);
	check("the review tab is the last tab", /Review answers/.test(review[1]) && /Not answered yet/.test(review.text), review.text);
	check("review shows what was answered and what is missing", /\(wrote\) symlinks please/.test(review.text) && /unanswered/.test(review.text), review.text);
	await press(host, KEYS.enter);
	check("Enter on an incomplete review bounces to the gap", /Question 1 of 2/.test(view(host)[1]), view(host).text);

	await press(host, "1");
	check("answering everything lands on review", /Review answers/.test(view(host)[1]) && /Ready to submit/.test(view(host).text), view(host).text);
	check("review lists both answers", /Install: Package/.test(view(host).text.replace(/\s+/g, " ")) && /\(wrote\) symlinks please/.test(view(host).text), view(host).text);
	await press(host, KEYS.enter);
	const multi = await running;
	check("multi-question header counts the questions", toolText(multi).startsWith("The user answered 2 questions:"), toolText(multi));
	check("provenance separates a pick from a typed answer", /\(user chose choice 1 of 3\)/.test(toolText(multi)) && /\(user wrote their own answer\)/.test(toolText(multi)), toolText(multi));
	check("headers reach the model", /Q \(Install\)/.test(toolText(multi)) && /Q \(Notes\)/.test(toolText(multi)), toolText(multi));
	check("an open question is reported as such", /choices: open question \(no suggested choices\)/.test(toolText(multi)), toolText(multi));
}

// ---------- panel: the own-answer entry on a question that has choices ----------

{
	const host = panelHost();
	const running = tool.execute(
		"tc-nplus1",
		{
			questions: [
				{ question: "Ship the tests?", header: "Tests", choices: [{ label: "Yes" }, { label: "Later" }] },
				{ question: "Push as one commit?", header: "Commit", choices: [{ label: "Squash" }, { label: "Keep two" }] },
			],
		},
		undefined,
		undefined,
		host.ctx,
	);
	await null;
	check("the footer names the key that opens free text", /3 write your own/.test(view(host).text), view(host).text);
	await press(host, "3");
	check("n+1 opens the own-answer entry", /Your answer/.test(view(host).text), view(host).text);
	await press(host, ...typed("both, actually"), KEYS.enter);
	check("typing an answer advances to the next question", /Question 2 of 2/.test(view(host)[1]), view(host).text);
	await press(host, "2");
	check("the last answer goes to review", /Ready to submit/.test(view(host).text), view(host).text);
	await press(host, KEYS.enter);
	const picked = await running;
	check("typed answers are reported as written by the user", /\(user wrote their own answer\)/.test(toolText(picked)) && /both, actually/.test(toolText(picked)), toolText(picked));
	check("picked answers are reported with their index", /\(user chose choice 2 of 2\)/.test(toolText(picked)), toolText(picked));
}

// ---------- panel: tab ring, and cancel ----------

{
	const host = panelHost();
	const running = tool.execute(
		"tc3",
		{
			questions: [
				{ question: "First?", header: "A", choices: [{ label: "One" }] },
				{ question: "Second?", header: "B", choices: [{ label: "Two" }] },
			],
		},
		undefined,
		undefined,
		host.ctx,
	);
	await null;
	await press(host, KEYS.left);
	check("← steps from the first question onto review", /Review answers/.test(view(host)[1]), view(host).text);
	await press(host, KEYS.left);
	check("review steps back to the last question", /Question 2 of 2/.test(view(host)[1]), view(host).text);
	await press(host, KEYS.shiftTab);
	check("shift+Tab behaves like ←", /Question 1 of 2/.test(view(host)[1]), view(host).text);
	await press(host, KEYS.right, KEYS.right);
	check("→ walks question, review and wraps to the start", /Review answers/.test(view(host)[1]), view(host).text);
	await press(host, KEYS.right);
	check("→ wraps out of review back onto the first question", /Question 1 of 2/.test(view(host)[1]), view(host).text);
	await press(host, KEYS.escape);
	const cancelled = await running;
	check("escape cancels the whole dialog", /pressed Escape and dismissed the questions/.test(toolText(cancelled)), toolText(cancelled));
	check("cancel tells the model not to re-ask in prose", /do not ask them in prose either/.test(toolText(cancelled)) && /safest assumption|blocked/.test(toolText(cancelled)), toolText(cancelled));
	check("cancel details flagged", cancelled.details.cancelled === true && cancelled.details.reason === "cancelled", JSON.stringify(cancelled.details));
}

// ---------- ctrl+c cancels too ----------

{
	const host = panelHost();
	const running = tool.execute("tc-ctrlc", { questions: [{ question: "Pick one", choices: [{ label: "Alpha" }] }] }, undefined, undefined, host.ctx);
	await null;
	await press(host, KEYS.ctrlC);
	const aborted = await running;
	check("ctrl+c cancels the dialog as well", /pressed Escape and dismissed/.test(toolText(aborted)) && aborted.details.cancelled === true, toolText(aborted));
}

// ---------- a dismissal must not make the gate fire ----------

{
	const gate = load();
	const gateCtx = gate.ctxFor();
	await gate.handlers.get("session_start")[0]({}, gateCtx);
	const host = panelHost();
	const dismissed = gate.tools.get("ask_user").execute("tc-cancel", { questions: [{ question: "Q?", choices: [{ label: "Alpha" }] }] }, undefined, undefined, host.ctx);
	await null;
	await press(host, KEYS.escape);
	await dismissed;
	const nudge = await gate.handlers.get("turn_end")[0](turnEnd("I'll stop here. Should I try the other branch?"), gateCtx);
	check("cancelling stops the gate for the rest of the run", nudge === undefined && gateCtx.notifyCalls.length === 1, JSON.stringify({ nudge, notify: gateCtx.notifyCalls }));
}

// ---------- normalisation, driven through the real tool ----------

{
	const host = panelHost();
	const running = tool.execute(
		"tc4",
		{
			questions: [
				{
					question: "  Padded?  ",
					header: `${" ".repeat(30)}Way too long a header for a tab`,
					choices: [{ label: "  Spaced  ", description: "  " }, { label: "" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }],
				},
				{ question: "Q2?", choices: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }, { label: "F" }] },
				{ question: "Q3?" },
				{ question: "Q4?" },
				{ question: "Q5 gets dropped" },
			],
		},
		undefined,
		undefined,
		host.ctx,
	);
	await null;
	await press(host, KEYS.escape);
	const normalized = (await running).details.questions;
	check("questions capped at 4", normalized.length === 4 && normalized[3].question === "Q4?", JSON.stringify(normalized.map((item) => item.question)));
	check("six offered choices are cut down to at most three", normalized[0].choices.length > 0 && normalized[0].choices.length <= 3, JSON.stringify(normalized[0].choices));
	check("the cap is applied before blanks are dropped", normalized[0].choices.map((choice) => choice.label).join(",") === "Spaced,B", JSON.stringify(normalized[0].choices));
	check("blank description collapses to undefined", normalized[0].choices[0].description === undefined, JSON.stringify(normalized[0].choices[0]));
	check("question text trimmed", normalized[0].question === "Padded?", JSON.stringify(normalized[0].question));
	check("headers are trimmed and cut to 24 columns", normalized[0].header.length === 24 && normalized[0].header.startsWith("Way too long"), JSON.stringify(normalized[0].header));
	check("missing header falls back to Qn", normalized[1].header === "Q2", JSON.stringify(normalized[1].header));
	check("valid choices are cut at exactly three", normalized[1].choices.map((choice) => choice.label).join(",") === "A,B,C", JSON.stringify(normalized[1].choices));

	const empty = await tool.execute("tc5", { questions: [] }, undefined, undefined, host.ctx);
	check("empty payload refuses instead of hanging", /needs at least one question/.test(toolText(empty)) && empty.details.reason === "unavailable", toolText(empty));
	const garbage = await tool.execute("tc6", {}, undefined, undefined, host.ctx);
	check("missing questions array handled without throwing", /needs at least one question/.test(toolText(garbage)), toolText(garbage));
}

// ---------- non-interactive modes ----------

{
	const selectCalls = [];
	const rpcCtx = {
		mode: "rpc",
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: fakeTheme(),
			notify: () => {},
			select: async (_question, labels) => {
				selectCalls.push(labels);
				return labels.at(-1);
			},
			input: async () => "whatever the user typed",
		},
	};
	const rpc = await tool.execute("tc7", { questions: [{ question: "Pick one", choices: [{ label: "Alpha" }, { label: "Beta" }] }] }, undefined, undefined, rpcCtx);
	check("rpc mode falls back to native dialogs", /whatever the user typed/.test(toolText(rpc)) && /\(user wrote their own answer\)/.test(toolText(rpc)), toolText(rpc));
	check("native select still offers an own-answer entry", selectCalls[0].at(-1) === "Write my own answer", JSON.stringify(selectCalls));

	const declinedCtx = { ...rpcCtx, ui: { ...rpcCtx.ui, select: async () => undefined } };
	const declined = await tool.execute("tc8", { questions: [{ question: "Pick one", choices: [{ label: "Alpha" }] }] }, undefined, undefined, declinedCtx);
	check("a declined native dialog reports a cancel", declined.details.cancelled === true && /Escape/.test(toolText(declined)), toolText(declined));

	const printCtx = load().ctxFor({ mode: "json", hasUI: false });
	const print = await tool.execute("tc9", { questions: [{ question: "Pick one", choices: [{ label: "Alpha" }] }] }, undefined, undefined, printCtx);
	check("print/json mode refuses to prompt", /non-interactive/.test(toolText(print)) && print.details.reason === "unavailable", toolText(print));
	check("print/json tells the model to assume and state it", /Make the safest reasonable choice yourself, state the assumption/.test(toolText(print)), toolText(print));
}

// ---------- prose-question gate ----------

function turnEnd(text, extra = {}) {
	return { outcome: "completed", toolResults: [], entries: [], message: { role: "assistant", content: [{ type: "text", text }] }, ...extra };
}

check("gate helper exported", typeof mod.looksLikeQuestionToUser === "function");
check("prose question detected", mod.looksLikeQuestionToUser("I wrote the README. Should I commit it now?") === true);
check("questionless reply passes", mod.looksLikeQuestionToUser("I wrote the README and committed it. Done.") === false);
check("empty reply passes", mod.looksLikeQuestionToUser("   ") === false);
check("a sign-off is not a question", mod.looksLikeQuestionToUser("Everything is committed, let me know if anything looks off.") === false);
check("imperative input request caught", mod.looksLikeQuestionToUser("Tell me which branch you want and I will continue.") === true);
check("only the tail of a long reply is inspected", mod.looksLikeQuestionToUser(`Should I commit the staged files?${"The suite covers registration, prompts, panel keys, renderers and the gate. ".repeat(40)}Nothing further is needed.`) === false);
check("a question in the tail of a long reply is caught", mod.looksLikeQuestionToUser(`${"The suite covers registration, prompts, panel keys, renderers and the gate. ".repeat(40)}Should I commit the staged files?`) === true);

{
	const gate = load();
	const ctx = gate.ctxFor();
	await gate.handlers.get("session_start")[0]({}, ctx);
	check("session start announces the gate", /prose-question gate on/.test(ctx.notifyCalls.at(-1)[1]), JSON.stringify(ctx.notifyCalls));

	const event = turnEnd("I have staged the files. Should I push to origin now?");
	const nudged = await gate.handlers.get("turn_end")[0](event, ctx);
	check("a prose question blocks the turn", nudged?.continue === true, JSON.stringify(nudged));
	check("nudge is a hidden custom message", nudged.entries.length === event.entries.length + 1 && nudged.entries.at(-1).customType === "ask-user-nudge" && nudged.entries.at(-1).display === false, JSON.stringify(nudged.entries));
	check("nudge text demands an ask_user call", /Call ask_user now/.test(nudged.entries.at(-1).content) && /do not add an "Other" choice/.test(nudged.entries.at(-1).content), nudged.entries.at(-1).content);
	check("the user sees why the answer changed shape", /Question found in prose reply/.test(ctx.notifyCalls.at(-1)[1]), JSON.stringify(ctx.notifyCalls));

	const second = await gate.handlers.get("turn_end")[0](turnEnd("And should I tag it too?"), ctx);
	check("the gate fires at most once per run", second === undefined, JSON.stringify(second));

	await gate.handlers.get("agent_start")[0]({}, ctx);
	const third = await gate.handlers.get("turn_end")[0](turnEnd("And should I tag it too?"), ctx);
	check("a later run may nudge again", third?.continue === true, JSON.stringify(third));

	await gate.commands.get("ask-user").handler("off", ctx);
	check("/ask-user off persists a session entry", gate.entries.at(-1)?.customType === "ask-user-settings" && gate.entries.at(-1).data.enforce === false, JSON.stringify(gate.entries));
	check("/ask-user off reports back", /gate off/.test(ctx.notifyCalls.at(-1)[1]), JSON.stringify(ctx.notifyCalls.at(-1)));
	check("gate off leaves the reply alone", (await gate.handlers.get("turn_end")[0](turnEnd("Should I squash the commits?"), ctx)) === undefined);

	await gate.commands.get("ask-user").handler("status", ctx);
	check("/ask-user status reports the state", /gate off/.test(ctx.notifyCalls.at(-1)[1]), JSON.stringify(ctx.notifyCalls.at(-1)));
	check("/ask-user on turns it back over", (await gate.commands.get("ask-user").handler("on", ctx), gate.entries.at(-1).data.enforce === true));
	check("arguments autocomplete", JSON.stringify(gate.commands.get("ask-user").getArgumentCompletions("o")) === JSON.stringify([{ value: "on", label: "on" }, { value: "off", label: "off" }]), JSON.stringify(gate.commands.get("ask-user").getArgumentCompletions("o")));
	check("a non-matching prefix returns no completions", gate.commands.get("ask-user").getArgumentCompletions("zz") === null);

	const resumed = load();
	const branchCtx = resumed.ctxFor({ branch: [{ type: "custom", customType: "ask-user-settings", data: { enforce: false } }] });
	await resumed.handlers.get("session_start")[0]({}, branchCtx);
	check("resume restores the persisted gate state", /prose-question gate off/.test(branchCtx.notifyCalls.at(-1)[1]), JSON.stringify(branchCtx.notifyCalls));
	check("the restored gate stays off", (await resumed.handlers.get("turn_end")[0](turnEnd("Should I rebase first?"), branchCtx)) === undefined);
	await resumed.handlers.get("session_tree")[0]({}, branchCtx);
	const afterTree = await resumed.handlers.get("turn_end")[0](turnEnd("Should I rebase first?"), branchCtx);
	check("tree navigation re-reads the setting", afterTree === undefined, JSON.stringify(afterTree));

	const noTools = load({ active: [] });
	const noToolsCtx = noTools.ctxFor();
	await noTools.handlers.get("session_start")[0]({}, noToolsCtx);
	check("the gate stands down when ask_user is not active", (await noTools.handlers.get("turn_end")[0](turnEnd("Should I commit now?"), noToolsCtx)) === undefined);
	check("no UI means no nudge", (await load().handlers.get("turn_end")[0](turnEnd("Should I commit now?"), load().ctxFor({ hasUI: false }))) === undefined);

	const midTurn = load();
	await midTurn.handlers.get("session_start")[0]({}, midTurn.ctxFor());
	const midCtx = midTurn.ctxFor();
	const withTools = await midTurn.handlers.get("turn_end")[0](turnEnd("Should I commit now?", { toolResults: [{ type: "toolResult" }] }), midCtx);
	check("mid-turn replies are left alone", withTools === undefined, JSON.stringify(withTools));
	check("unfinished turns are left alone", (await midTurn.handlers.get("turn_end")[0](turnEnd("Should I commit now?", { outcome: "aborted" }), midCtx)) === undefined);
	check("non-assistant messages are left alone", (await midTurn.handlers.get("turn_end")[0](turnEnd("Should I commit now?", { message: { role: "user", content: [{ type: "text", text: "Should I commit now?" }] } }), midCtx)) === undefined);
}

// ---------- renderers ----------

{
	const theme = fakeTheme();
	const questions = [{ question: "Which licence?", header: "Licence", choices: [{ label: "GPL-3.0-only" }] }];
	const collapsed = strip(tool.renderCall({ questions }, theme, { expanded: false }).render(60)[0]);
	check("renderCall summarises the question count", /1 question/.test(collapsed) && /Licence/.test(collapsed), collapsed);
	const expanded = tool.renderCall({ questions }, theme, { expanded: true }).render(60).map(strip).join("\n");
	check("expanded renderCall lists choices and the own-answer entry", /GPL-3\.0-only/.test(expanded) && /Write my own answer/.test(expanded), expanded);

	const answered = tool.renderResult({ content: [{ type: "text", text: "x" }], details: { questions, answers: [{ kind: "custom", value: "GPL please" }], cancelled: false } }, { expanded: false }, theme, {});
	check("renderResult shows a typed answer", /\(wrote\) GPL please/.test(answered.render(60).map(strip).join("\n")), answered.render(60).map(strip).join("\n"));
	const unanswered = tool.renderResult({ content: [{ type: "text", text: "x" }], details: { questions, answers: [null], cancelled: false } }, { expanded: false }, theme, {});
	check("renderResult marks unanswered rows", /unanswered/.test(unanswered.render(60).map(strip).join("\n")));
	const noUi = tool.renderResult({ content: [{ type: "text", text: "x" }], details: { questions, answers: [null], cancelled: true, reason: "unavailable" } }, { expanded: false }, theme, {});
	check("renderResult explains a missing UI", /No UI available/.test(noUi.render(60).map(strip).join("\n")));
	const bare = tool.renderResult({ content: [{ type: "text", text: "plain" }], details: undefined }, { expanded: false }, theme, {});
	check("renderResult survives a missing details block", /plain/.test(bare.render(60).map(strip).join("\n")));
}

// ---------- demo command ----------

{
	const demo = load();
	const cli = demo.ctxFor({ mode: "json", hasUI: true });
	await demo.commands.get("ask-user").handler("demo", cli);
	check("demo refuses to run outside interactive mode", /needs interactive mode/.test(cli.notifyCalls.at(-1)[1]), JSON.stringify(cli.notifyCalls));

	const demoNotices = [];
	const panel = panelHost();
	const demoCtx = { ...panel.ctx, ui: { ...panel.ctx.ui, notify: (text, kind) => demoNotices.push([kind, text]) } };
	const demoRun = demo.commands.get("ask-user").handler("demo", demoCtx);
	await null;
	check("demo opens the real dialog with sample questions", /Theme/.test(view(panel)[2]) && /Notes/.test(view(panel)[2]), view(panel).text);
	await press(panel, KEYS.right);
	check("a sample question with no choices opens free text", /Your answer/.test(view(panel).text), view(panel).text);
	await press(panel, KEYS.escape, KEYS.escape);
	await demoRun;
	check("a dismissed demo says so instead of failing quietly", demoNotices.some(([kind, text]) => kind === "warning" && /dismissed/.test(text)), JSON.stringify(demoNotices));
	await demo.handlers.get("session_start")[0]({}, demoCtx);
	await demo.commands.get("ask-user").handler("", demoCtx);
	check("a bare /ask-user prints the current state", /ask_user tool enabled/.test(demoNotices.at(-1)[1]), JSON.stringify(demoNotices.at(-1)));
}

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
