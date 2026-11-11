/**
 * ask-user — OpenCode-style interactive questions for pi.
 *
 * Registers an `ask_user` tool: the model asks up to 4 questions at once, each with
 * up to 3 suggested choices, and the user can always type their own answer instead.
 *
 * It also makes the model aware of the tool and forces it to be used:
 *  - a dedicated system-prompt section spells out the rule ("never ask in prose")
 *  - tool promptSnippet/promptGuidelines advertise it in <tools>/<rules>
 *  - a `turn_end` gate detects a question left in the final prose reply, nudges the
 *    model with a custom message, and requests one more provider request so the
 *    model has to ask through `ask_user` instead.
 *
 * `/ask-user on|off|status` toggles the prose-question gate for the session.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	type KeybindingsManager,
	matchesKey,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const MAX_QUESTIONS = 4;
const MAX_CHOICES = 3;
const CUSTOM_CHOICE_LABEL = "Write my own answer";

const ChoiceSchema = Type.Object({
	label: Type.String({ description: "Short choice label the user selects, 1-5 words" }),
	description: Type.Optional(
		Type.String({ description: "Optional one-line detail or tradeoff shown under the label" }),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description: "The question, phrased so it makes sense without your reply text",
	}),
	header: Type.Optional(
		Type.String({ description: 'Short tab label for this question, e.g. "Scope" or "Priority" (max 24 chars)' }),
	),
	choices: Type.Optional(
		Type.Array(ChoiceSchema, {
			maxItems: MAX_CHOICES,
			description: `Up to ${MAX_CHOICES} suggested choices. Omit for an open-ended question. Never add "Other" or "Custom" yourself: the user can always write their own answer.`,
		}),
	),
});

const AskUserSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "Questions to ask the user in one dialog. Batch related questions into a single call.",
	}),
});

type AskUserInput = Static<typeof AskUserSchema>;

// ---------------------------------------------------------------------------
// Data shapes (also stored in tool result `details` for session state/rendering)
// ---------------------------------------------------------------------------

interface Choice {
	label: string;
	description?: string;
}

interface Question {
	question: string;
	header: string;
	choices: Choice[];
}

interface Answer {
	kind: "choice" | "custom";
	value: string;
	/** 1-based index of the chosen choice. */
	choiceIndex?: number;
}

interface PanelResult {
	/** Aligned with `questions`; null means the question was left unanswered. */
	answers: (Answer | null)[];
	cancelled: boolean;
}

interface AskDetails {
	questions: Question[];
	answers: (Answer | null)[];
	cancelled: boolean;
	reason?: "cancelled" | "unavailable";
}

// ---------------------------------------------------------------------------
// Normalization + model-facing result text
// ---------------------------------------------------------------------------

function normalizeQuestions(input: AskUserInput): Question[] {
	const questions = Array.isArray(input?.questions) ? input.questions : [];
	return questions.slice(0, MAX_QUESTIONS).map((raw, index) => {
		const header = (raw?.header ?? "").trim().slice(0, 24);
		return {
			question: (raw?.question ?? "").trim(),
			header: header || `Q${index + 1}`,
			choices: (raw?.choices ?? [])
				.slice(0, MAX_CHOICES)
				.map((choice) => ({
					label: (choice?.label ?? "").trim(),
					description: choice?.description?.trim() || undefined,
				}))
				.filter((choice) => choice.label.length > 0),
		};
	});
}

function describeChoices(question: Question): string {
	if (question.choices.length === 0) return "open question (no suggested choices)";
	return question.choices.map((choice, i) => `${i + 1}) ${choice.label}`).join(", ");
}

function describeAnswer(question: Question, answer: Answer | null): string {
	if (!answer) return "no answer";
	if (answer.kind === "custom") return `${answer.value} (user wrote their own answer)`;
	return `${answer.value} (user chose choice ${answer.choiceIndex} of ${question.choices.length})`;
}

function formatAnswers(questions: Question[], answers: (Answer | null)[]): string {
	const lines = [`The user answered ${questions.length} question${questions.length === 1 ? "" : "s"}:`];
	questions.forEach((question, index) => {
		lines.push("");
		lines.push(`${index + 1}. Q (${question.header}): ${question.question}`);
		lines.push(`   choices: ${describeChoices(question)}`);
		lines.push(`   A: ${describeAnswer(question, answers[index] ?? null)}`);
	});
	lines.push("");
	lines.push(
		"Use these answers as the user's actual instructions. Where the user wrote their own answer, follow it over your suggested choices.",
	);
	return lines.join("\n");
}

const CANCEL_TEXT = [
	"The user pressed Escape and dismissed the questions without answering.",
	"Do not call ask_user again for the same questions, and do not ask them in prose either.",
	"Either proceed with the safest assumption and state it clearly in your reply, or stop and report that you are blocked on user input.",
].join(" ");

const UNAVAILABLE_TEXT = [
	"ask_user cannot prompt the user right now because this run is non-interactive.",
	"Do not ask the user anything in prose either. Make the safest reasonable choice yourself, state the assumption clearly in your reply, and continue working.",
].join(" ");

/** Sample questions for `/ask-user demo`. */
const DEMO_QUESTIONS: Question[] = [
	{
		question: "Which colour scheme should the example use?",
		header: "Theme",
		choices: [
			{ label: "Dark", description: "Default: easier on the eyes at night" },
			{ label: "Light", description: "Better in a bright room" },
			{ label: "Follow terminal", description: "Match the terminal palette automatically" },
		],
	},
	{
		question: "Anything else the example should know? This one has no suggested choices, so answer freely.",
		header: "Notes",
		choices: [],
	},
];

// ---------------------------------------------------------------------------
// Interactive panel (ctx.ui.custom): questions as tabs, choices, free-text answer
// ---------------------------------------------------------------------------

class AskUserPanel implements Component, Focusable {
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private questions: Question[];
	private done: (result: PanelResult) => void;

	private tabIndex = 0;
	private choiceIndex = 0;
	private writing = false;
	private answers: (Answer | null)[];
	private choiceCursor: number[];
	private input: Input;

	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private isFocused = false;
	private closed = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		questions: Question[],
		done: (result: PanelResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.questions = questions;
		this.done = done;
		this.answers = questions.map(() => null);
		this.choiceCursor = questions.map(() => 0);
		this.input = new Input({
			prompt: theme.fg("muted", " Your answer: "),
			placeholder: "type an answer, then press Enter",
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		this.input.focused = true;
		this.input.onSubmit = (value) => this.submitCustomAnswer(value);
		this.input.onEscape = () => {
			this.writing = false;
			this.refresh();
		};

		const first = questions[0];
		if (first && first.choices.length === 0) {
			this.writing = true;
		}
	}

	set focused(value: boolean) {
		this.isFocused = value;
		this.input.focused = value;
	}

	get focused(): boolean {
		return this.isFocused;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private refresh(): void {
		if (this.closed) return;
		this.invalidate();
		this.tui.requestRender();
	}

	private get isReviewTab(): boolean {
		return this.tabIndex === this.questions.length;
	}

	private get reviewTab(): number {
		return this.questions.length;
	}

	private currentQuestion(): Question | undefined {
		return this.questions[this.tabIndex];
	}

	/** Rendered choices for the current question: the model's choices plus "write my own". */
	private renderedChoices(question: Question): { label: string; description?: string; custom: boolean }[] {
		return [
			...question.choices.map((choice) => ({
				label: choice.label,
				description: choice.description,
				custom: false,
			})),
			{ label: CUSTOM_CHOICE_LABEL, custom: true },
		];
	}

	private firstUnanswered(): number {
		return this.answers.findIndex((answer) => answer === null);
	}

	private allAnswered(): boolean {
		return this.firstUnanswered() === -1;
	}

	private enterTab(index: number): void {
		this.tabIndex = Math.max(0, Math.min(this.reviewTab, index));
		this.writing = false;
		const question = this.currentQuestion();
		if (question) {
			this.choiceIndex = this.choiceCursor[this.tabIndex] ?? 0;
			const answer = this.answers[this.tabIndex];
			// Nothing to pick when the model suggested no choices: go straight to typing.
			if (question.choices.length === 0 && !answer) this.writing = true;
		}
		this.refresh();
	}

	private startWriting(): void {
		const answer = this.answers[this.tabIndex];
		this.input.setValue(answer?.kind === "custom" ? answer.value : "");
		this.writing = true;
		this.refresh();
	}

	private submitCustomAnswer(value: string): void {
		const trimmed = value.trim();
		if (!trimmed) {
			this.writing = false;
			this.refresh();
			return;
		}
		this.answers[this.tabIndex] = { kind: "custom", value: trimmed };
		this.afterAnswer();
	}

	private selectChoice(index: number): void {
		const question = this.currentQuestion();
		if (!question) return;
		const rendered = this.renderedChoices(question);
		const choice = rendered[index];
		if (!choice) return;
		this.choiceCursor[this.tabIndex] = index;
		this.choiceIndex = index;
		if (choice.custom) {
			this.startWriting();
			return;
		}
		this.answers[this.tabIndex] = { kind: "choice", value: choice.label, choiceIndex: index + 1 };
		this.afterAnswer();
	}

	private afterAnswer(): void {
		if (this.questions.length === 1) {
			this.finish(false);
			return;
		}
		const next = this.firstUnanswered();
		this.enterTab(next === -1 ? this.reviewTab : next);
	}

	private finish(cancelled: boolean): void {
		this.closed = true;
		this.done({ answers: this.answers.map((answer) => answer ?? null), cancelled });
	}

	handleInput(data: string): void {
		if (this.writing) {
			// Input owns all text editing here, including Enter (submit) and Escape (back to choices).
			this.input.handleInput(data);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(true);
			return;
		}

		const multi = this.questions.length > 1;
		if (multi) {
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				this.enterTab((this.tabIndex - 1 + this.reviewTab + 1) % (this.reviewTab + 1));
				return;
			}
			if (matchesKey(data, Key.tab) || this.keybindings.matches(data, "tui.input.tab") || matchesKey(data, Key.right)) {
				this.enterTab((this.tabIndex + 1) % (this.reviewTab + 1));
				return;
			}
		}

		if (this.isReviewTab) {
			if (matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.select.confirm")) {
				const missing = this.firstUnanswered();
				if (missing === -1) this.finish(false);
				else this.enterTab(missing);
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.enterTab(this.reviewTab - 1);
				return;
			}
			return;
		}

		const question = this.currentQuestion();
		if (!question) return;
		const rendered = this.renderedChoices(question);

		if (matchesKey(data, Key.up) || this.keybindings.matches(data, "tui.select.up")) {
			this.choiceIndex = Math.max(0, this.choiceIndex - 1);
			this.choiceCursor[this.tabIndex] = this.choiceIndex;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down) || this.keybindings.matches(data, "tui.select.down")) {
			this.choiceIndex = Math.min(rendered.length - 1, this.choiceIndex + 1);
			this.choiceCursor[this.tabIndex] = this.choiceIndex;
			this.refresh();
			return;
		}

		// Numeric quick pick: 1..n select choices, n+1 opens the free-text answer.
		if (/^[1-9]$/.test(data)) {
			const index = Number(data) - 1;
			if (index < rendered.length) {
				this.selectChoice(index);
				return;
			}
			this.selectChoice(rendered.length - 1);
			return;
		}

		if (matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.select.confirm")) {
			this.selectChoice(this.choiceIndex);
		}
	}

	/** Wrap `text` after a styled `prefix`, keeping continuation lines aligned. */
	private wrap(prefix: string, text: string, width: number): string[] {
		const prefixWidth = visibleWidth(prefix);
		if (prefixWidth >= width) return wrapTextWithAnsi(prefix + text, Math.max(1, width));
		const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
		const continuation = " ".repeat(prefixWidth);
		return wrapped.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
	}

	private renderHeader(width: number): string {
		const theme = this.theme;
		const left = theme.fg("accent", theme.bold(this.questions.length === 1 ? "Answer question" : "Answer questions"));
		const right = this.isReviewTab
			? theme.fg("muted", "Review answers")
			: theme.fg("dim", `Question ${this.tabIndex + 1} of ${this.questions.length}`);
		const gap = Math.max(2, width - 1 - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(` ${left}${" ".repeat(gap)}${right}`, width);
	}

	private renderTabBar(width: number): string {
		const theme = this.theme;
		const parts: string[] = [];
		this.questions.forEach((question, index) => {
			const answered = this.answers[index] !== null;
			const text = ` ${answered ? "■" : "□"} ${question.header} `;
			const styled =
				index === this.tabIndex
					? theme.bg("selectedBg", theme.fg("text", text))
					: theme.fg(answered ? "success" : "muted", text);
			parts.push(`${styled} `);
		});
		const submitText = " ✓ Submit ";
		parts.push(
			this.isReviewTab
				? theme.bg("selectedBg", theme.fg("text", submitText))
				: theme.fg(this.allAnswered() ? "success" : "dim", submitText),
		);
		return truncateToWidth(`  ${parts.join("")}`, width);
	}

	private renderChoices(width: number): string[] {
		const theme = this.theme;
		const question = this.currentQuestion();
		if (!question) return [];
		const rendered = this.renderedChoices(question);
		const lines: string[] = [];
		rendered.forEach((choice, index) => {
			const selected = index === this.choiceIndex;
			const marker = selected ? theme.fg("accent", "> ") : "  ";
			const label = `${index + 1}. ${choice.label}`;
			const color = selected ? "accent" : choice.custom ? "muted" : "text";
			lines.push(...this.wrap(marker, theme.fg(color, label), width));
			if (choice.description) {
				lines.push(...this.wrap("     ", theme.fg("muted", choice.description), width));
			}
		});
		return lines;
	}

	private renderReview(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		lines.push(...this.wrap(" ", theme.fg("accent", theme.bold(this.allAnswered() ? "Ready to submit" : "Not answered yet")), width));
		lines.push("");
		this.questions.forEach((question, index) => {
			const answer = this.answers[index];
			const questionLabel = `${question.header}:`;
			if (!answer) {
				lines.push(...this.wrap(" ", `${theme.fg("muted", questionLabel)} ${theme.fg("warning", "unanswered")}`, width));
				return;
			}
			const value = answer.kind === "custom" ? `(wrote) ${answer.value}` : answer.value;
			lines.push(...this.wrap(" ", `${theme.fg("muted", questionLabel)} ${theme.fg("text", value)}`, width));
		});
		return lines;
	}

	private renderHint(width: number): string[] {
		const theme = this.theme;
		const confirm = this.keybindings.getKeys("tui.select.confirm")[0] ?? "Enter";
		const cancel = this.keybindings.getKeys("tui.select.cancel")[0] ?? "Esc";
		const move = `${this.keybindings.getKeys("tui.select.up")[0] ?? "Up"}/${this.keybindings.getKeys("tui.select.down")[0] ?? "Down"}`;
		const parts: string[] = [];
		if (this.writing) {
			parts.push(`${confirm} submit`, `${cancel} back to choices`);
		} else if (this.isReviewTab) {
			if (this.allAnswered()) parts.push(`${confirm} submit`);
			else parts.push(`${confirm} answer the next unanswered question`);
			if (this.questions.length > 1) parts.push("Tab/←→ switch question");
		} else {
			parts.push(`${move} move`, `${confirm} select`);
			const question = this.currentQuestion();
			const customIndex = question ? question.choices.length + 1 : 1;
			parts.push(`${customIndex} write your own`);
			if (this.questions.length > 1) parts.push("Tab/←→ switch question");
			parts.push(`${cancel} cancel`);
		}
		return this.wrap(" ", theme.fg("dim", parts.join(" • ")), width);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const theme = this.theme;
		const renderWidth = Math.max(20, width);
		const border = theme.fg("accent", "─".repeat(renderWidth));
		const lines: string[] = [border, this.renderHeader(renderWidth)];

		if (this.questions.length > 1) {
			lines.push(this.renderTabBar(renderWidth));
		}
		lines.push("");

		if (this.isReviewTab) {
			lines.push(...this.renderReview(renderWidth));
		} else {
			const question = this.currentQuestion();
			if (question) {
				lines.push(...this.wrap(" ", theme.fg("text", question.question), renderWidth));
				lines.push("");
				if (question.choices.length > 0) {
					lines.push(...this.renderChoices(renderWidth));
				} else {
					lines.push(
						...this.wrap(" ", theme.fg("muted", "No suggested choices, so this one is yours to answer freely."), renderWidth),
					);
				}
			}
			if (this.writing) {
				lines.push("");
				for (const line of this.input.render(Math.max(4, renderWidth - 1))) {
					lines.push(` ${line}`);
				}
			}
		}

		lines.push("");
		lines.push(...this.renderHint(renderWidth));
		lines.push(border);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Prompt guidance
// ---------------------------------------------------------------------------

const ASK_RULES_SECTION = `You can ask the user questions interactively with the ask_user tool. It renders a dialog: each question gets up to 3 suggested choices, plus a permanent "Write my own answer" entry the user can type into.

Rules:
- When you need information, a decision, a preference, or a confirmation from the user, you MUST call ask_user. Never put the question only in your reply text and stop.
- Never end a turn with prose questions such as "Should I ...?", "Do you want ...?", "Which one do you prefer?", or "Let me know if you would like X" when the answer changes what you do next. Convert those into an ask_user call instead.
- Put all related questions in ONE ask_user call (up to 4 questions) rather than one question per turn.
- Give each question a short header (e.g. "Scope", "Priority") and 1-${MAX_CHOICES} concrete choices. Each choice needs a short label and should carry a one-line description with its tradeoff.
- Order choices by your own recommendation, best first, and say so in your reply after the answers come back.
- Choices are suggestions, not constraints: never add "Other", "Custom", or "Something else" yourself, because the user can always write their own answer. Omit choices entirely when the question is genuinely open-ended.
- Ask before doing work that depends on the answer, not after doing it.
- Do not use ask_user for anything you can determine yourself from the repository, tool output, docs, or AGENTS.md, and do not use it to request file contents that a tool can read.
- If the user cancels the dialog, stop asking: take the safest assumption, state it, and continue or report that you are blocked.`;

const TOOL_GUIDELINES = [
	"Use ask_user whenever you need a decision, preference, clarification, or confirmation from the user; never ask such questions only in reply text.",
	"Batch related questions into one ask_user call, each with up to 3 choices plus a header; the user can always write their own answer, so do not add an \"Other\" choice.",
	"Do not end a turn with an unanswered question for the user in prose; call ask_user instead of writing the question.",
	"Do not call ask_user for facts you can look up yourself with read, grep, find, ls, or bash.",
];

// ---------------------------------------------------------------------------
// Prose-question detection (the enforcement gate)
// ---------------------------------------------------------------------------

const QUESTION_PATTERNS: RegExp[] = [
	/\bshould (?:i|we)\b/i,
	/\bwould you (?:like|prefer|want|rather)\b/i,
	/\bdo you (?:want|prefer|like|need|think)\b/i,
	/\bdo you have a preference\b/i,
	/\bany preference\b/i,
	/\bwhich (?:one|of|option|choice|approach|way|version|style|variant|method|framework|library|file|branch)\b/i,
	/\bplease (?:choose|pick|select|specify|confirm|tell me|clarify)\b/i,
	/\bpick (?:one|between)\b/i,
	/\bchoose between\b/i,
	/\bwant me to\b/i,
	/\bhow (?:should|would|do) (?:i|we|you) (?:like|proceed|handle|want)\b/i,
	/\bwould it be better\b/i,
	/\bor (?:should|do) (?:i|you)\b/i,
	/\b(?:confirm|clarify) (?:whether|which|what)\b/i,
	/\b(?:can|could) you (?:tell me|clarify|confirm|specify|choose|pick)\b/i,
	/\bwhat (?:should|would|do) (?:i|we)\b/i,
	/\b(?:should|would|is|are|do|does|which|what)\b[^.!?]{0,60}\bor\b[^.!?]{0,40}\?\s*$/i,
	/\b(?:okay|ok) (?:to|if) (?:i|to|proceed|going|continuing|making)\b/i,
	/\bare you (?:happy|okay|fine) (?:with|if)\b/i,
];

/**
 * Phrases that demand an answer from the user even without a question mark.
 * Deliberately narrow: "let me know if anything looks off" is a sign-off, while
 * "tell me which one you want" is a question that should have been asked via ask_user.
 */
const INPUT_REQUEST_PATTERNS: RegExp[] = [
	/\blet me know (?:if|whether|which|what|how) (?:you|the|to|about|more)\b/i,
	/\btell me (?:which|what|how|whether|where|when|who|why)\b/i,
	/\b(?:specify|indicate|confirm|choose|pick) (?:which|what|where)\b/i,
	/\bneed to ask (?:you|them|the user)\b/i,
	/\breply with (?:one|which|an option|a number|your choice)\b/i,
	/\bplease (?:choose|pick|select|specify|confirm)\b/i,
	/\b(?:choose|pick) between\b/i,
	/\bneed (?:your |the user's )?(?:decision|answer|input|go-?ahead)\b/i,
	/\bawaiting (?:your )?(?:answer|input|decision)\b/i,
];

/**
 * Heuristic: does this final assistant reply leave a question for the user that
 * should have gone through `ask_user`?
 */
export function looksLikeQuestionToUser(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;
	// Only look at the tail of the reply: that is where a closing question lives.
	const tail = trimmed.length > 1500 ? trimmed.slice(-1500) : trimmed;
	if (INPUT_REQUEST_PATTERNS.some((pattern) => pattern.test(tail))) return true;
	if (!tail.includes("?")) return false;
	return QUESTION_PATTERNS.some((pattern) => pattern.test(tail));
}

const NUDGE_TEXT = [
	"You ended your reply with a question for the user instead of using the ask_user tool.",
	"Call ask_user now with that question (and any other open questions), giving each a short header and up to 3 suggested choices.",
	"The user can always write their own answer, so do not add an \"Other\" choice.",
	"Do not repeat the question in prose.",
].join(" ");

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function askUser(pi: ExtensionAPI) {
	let enforce = true;
	let nudgedThisRun = false;
	let cancelledThisRun = false;

	const reconstruct = (ctx: ExtensionContext) => {
		enforce = true;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "ask-user-settings") {
				const data = entry.data as { enforce?: boolean } | undefined;
				if (data && typeof data.enforce === "boolean") enforce = data.enforce;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
		nudgedThisRun = false;
		cancelledThisRun = false;
		if (ctx.mode === "tui") {
			ctx.ui.notify(`ask_user ready · prose-question gate ${enforce ? "on" : "off"} (/ask-user on|off)`, "info");
		}
	});
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.on("agent_start", async () => {
		nudgedThisRun = false;
		cancelledThisRun = false;
	});

	// Teach the model about the tool as its own patchable prompt section. Always set it, so
	// runs started by custom messages do not make the section flicker in and out.
	pi.on("before_agent_start", async (event) => {
		if (!pi.getActiveTools().includes("ask_user")) return;
		const options = event.systemPromptOptions;
		if (!options.sections) options.sections = {};
		options.sections.ask_user = ASK_RULES_SECTION;
	});

	// Enforcement gate: a final reply that asks the user something gets sent back.
	pi.on("turn_end", async (event, ctx) => {
		if (!enforce || nudgedThisRun || cancelledThisRun) return;
		if (!ctx.hasUI) return;
		if (event.outcome !== "completed") return;
		if (event.toolResults.length > 0) return;
		if (event.message.role !== "assistant") return;
		if (!pi.getActiveTools().includes("ask_user")) return;

		const text = event.message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (!looksLikeQuestionToUser(text)) return;

		nudgedThisRun = true;
		ctx.ui.notify("Question found in prose reply — asking the model to use ask_user", "info");
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "ask-user-nudge",
					content: NUDGE_TEXT,
					display: false,
				},
			],
			continue: true,
		};
	});

	pi.registerCommand("ask-user", {
		description: "ask_user controls: /ask-user on|off|status|demo",
		getArgumentCompletions: (prefix: string) => {
			const items = ["on", "off", "status", "demo"].map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enforce = arg === "on";
				pi.appendEntry("ask-user-settings", { enforce });
				ctx.ui.notify(`Prose-question gate ${enforce ? "on" : "off"}`, "info");
				return;
			}
			if (arg === "demo") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("/ask-user demo needs interactive mode", "warning");
					return;
				}
				const result = await askViaPanel(DEMO_QUESTIONS, ctx);
				if (!result) {
					ctx.ui.notify("Demo dismissed without answers", "warning");
					return;
				}
				ctx.ui.notify(formatAnswers(DEMO_QUESTIONS, result.answers), "info");
				return;
			}
			ctx.ui.notify(
				`ask_user tool enabled · prose-question gate ${enforce ? "on" : "off"} · /ask-user on|off|demo`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: [
			"Ask the user questions through an interactive dialog. This is the ONLY way to ask the user something: never write a question in your reply text and stop.",
			`Provide 1-${MAX_QUESTIONS} questions. Each question gets a short header and up to ${MAX_CHOICES} suggested choices.`,
			`The dialog always offers "${CUSTOM_CHOICE_LABEL}", so the user can answer with their own words. Do not add an "Other" or "Custom" choice yourself.`,
			"Use it for decisions, preferences, scope, ambiguous requirements, and confirming destructive actions. Do not use it for facts you can read or run yourself.",
			"Batch related questions into one call. Wait for the answers before doing work that depends on them.",
		].join(" "),
		promptSnippet: "Ask the user questions interactively (up to 4 questions, up to 3 choices each, own answer always allowed)",
		promptGuidelines: TOOL_GUIDELINES,
		parameters: AskUserSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = normalizeQuestions(params as AskUserInput);
			if (questions.length === 0 || questions.some((question) => question.question.length === 0)) {
				return {
					content: [
						{
							type: "text",
							text: "ask_user needs at least one question with non-empty text. Call it again with a real question.",
						},
					],
					details: { questions, answers: [], cancelled: true, reason: "unavailable" } as AskDetails,
				};
			}

			// Non-interactive runs cannot be prompted. RPC gets native dialogs; print/json gets guidance.
			if (ctx.mode !== "tui") {
				if (!ctx.hasUI) {
					return {
						content: [{ type: "text", text: UNAVAILABLE_TEXT }],
						details: {
							questions,
							answers: questions.map(() => null),
							cancelled: true,
							reason: "unavailable",
						} as AskDetails,
					};
				}
				const answers = await askWithDialogs(questions, ctx);
				if (!answers) {
					return {
						content: [{ type: "text", text: CANCEL_TEXT }],
						details: { questions, answers: questions.map(() => null), cancelled: true, reason: "cancelled" } as AskDetails,
					};
				}
				return {
					content: [{ type: "text", text: formatAnswers(questions, answers) }],
					details: { questions, answers, cancelled: false } as AskDetails,
				};
			}

			const result = await askViaPanel(questions, ctx);
			if (!result) {
				cancelledThisRun = true;
				return {
					content: [{ type: "text", text: CANCEL_TEXT }],
					details: { questions, answers: questions.map(() => null), cancelled: true, reason: "cancelled" } as AskDetails,
				};
			}

			const answers = result.answers.map((answer) => answer ?? null);
			return {
				content: [{ type: "text", text: formatAnswers(questions, answers) }],
				details: { questions, answers, cancelled: false } as AskDetails,
			};
		},

		renderCall(args, theme, context) {
			const questions = ((args as Partial<AskUserInput>)?.questions ?? []) as QuestionSchemaShape[];
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
			const headers = questions.map((question, index) => question.header?.trim() || `Q${index + 1}`);
			if (headers.length > 0) text += theme.fg("dim", ` (${headers.join(", ")})`);
			if (context.expanded && questions.length > 0) {
				text += "\n";
				questions.forEach((question, index) => {
					text += `\n${theme.fg("muted", `${index + 1}. ${question.question}`)}`;
					const choices = question.choices ?? [];
					choices.forEach((choice, choiceIndex) => {
						text += `\n${theme.fg("dim", `     ${choiceIndex + 1}) ${choice.label}`)}`;
					});
				});
				text += `\n${theme.fg("dim", `     + ${CUSTOM_CHOICE_LABEL}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, _context) {
			const details = result.details as AskDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.cancelled) {
				const label = details.reason === "unavailable" ? "No UI available" : "Cancelled — no answers";
				return new Text(theme.fg("warning", label), 0, 0);
			}
			let text = "";
			details.questions.forEach((question, index) => {
				const answer = details.answers[index] ?? null;
				if (!answer) {
					text += `${theme.fg("warning", "• ")}${theme.fg("muted", `${question.header}:`)} ${theme.fg("warning", "unanswered")}\n`;
					return;
				}
				const value = answer.kind === "custom" ? `(wrote) ${answer.value}` : answer.value;
				text += `${theme.fg("success", "✓ ")}${theme.fg("muted", `${question.header}:`)} ${theme.fg("accent", value)}\n`;
			});
			if (options.expanded) {
				text += "\n";
				details.questions.forEach((question, index) => {
					text += `${theme.fg("dim", `${index + 1}. ${question.question}`)}\n`;
					question.choices.forEach((choice, choiceIndex) => {
						text += `${theme.fg("dim", `     ${choiceIndex + 1}) ${choice.label}`)}\n`;
					});
				});
			}
			return new Text(text.trimEnd(), 0, 0);
		},
	});
}

// Loose shape for reading raw tool-call args in renderCall.
interface QuestionSchemaShape {
	question?: string;
	header?: string;
	choices?: { label?: string }[];
}

/** Show the interactive panel. Returns null when it was dismissed or is unavailable. */
async function askViaPanel(questions: Question[], ctx: ExtensionContext): Promise<PanelResult | null> {
	const result = await ctx.ui.custom<PanelResult>(
		(tui, theme, keybindings, done) => new AskUserPanel(tui, theme, keybindings, questions, done),
		{
			blocked: {
				kind: "question",
				message: questions[0]?.question.slice(0, 80) ?? "Waiting for the user",
			},
		},
	);
	if (!result || result.cancelled || result.answers.every((answer) => answer === null)) return null;
	return { answers: result.answers.map((answer) => answer ?? null), cancelled: false };
}

/** RPC fallback: one native select (plus input dialog) per question. */
async function askWithDialogs(questions: Question[], ctx: ExtensionContext): Promise<(Answer | null)[] | null> {
	const answers: (Answer | null)[] = [];
	for (const question of questions) {
		const labels = question.choices.map((choice) => choice.label);
		const choice = await ctx.ui.select(question.question, [...labels, CUSTOM_CHOICE_LABEL]);
		if (choice === undefined) return null;
		if (choice === CUSTOM_CHOICE_LABEL) {
			const typed = await ctx.ui.input(question.question, "type your answer");
			if (typed === undefined || typed.trim().length === 0) return null;
			answers.push({ kind: "custom", value: typed.trim() });
			continue;
		}
		answers.push({ kind: "choice", value: choice, choiceIndex: labels.indexOf(choice) + 1 });
	}
	return answers;
}