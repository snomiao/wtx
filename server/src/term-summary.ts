/**
 * Extract a terse, UI-friendly summary from a rendered terminal viewport.
 * Designed for Claude Code sessions; gracefully degrades for plain shells.
 *
 * Input: the already-rendered screen text (see renderTerminalBuffer).
 * Output: state + recap + lastAssistant + error/waiting hints.
 */

export interface TermSummary {
  state: "running" | "bg" | "idle" | "empty";
  recap: string | null;
  lastAssistant: string | null;
  errorCount: number;
  waitingForUser: boolean;
  workedSec: number | null;
}

const SPINNER_RE =
  /^[✻✽✢✶⋯⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✱◐◑◒◓]\s+\S+…\s*\(\d+s(?:\s*·\s*[↑↓]\s*[\d.]+k?\s*tokens)?\)?\s*$/u;
const USER_PROMPT_RE = /^❯(\s|$)/;
const DIVIDER_RE = /^[─━]{5,}$/;
const RECAP_RE = /^※\s*recap:\s*(.*)$/;
const WORKED_RE = /✻\s+(?:Worked|Cogitated)\s+for\s+(?:(\d+)m\s+)?(\d+)s/i;
const RECAP_TRAILER_RE = /\s*\(disable recaps? in \/config\)\s*$/i;

function cleanRecap(s: string): string {
  return s.replace(RECAP_TRAILER_RE, "").trim();
}

function extractRecap(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(RECAP_RE);
    if (!m) continue;
    let buf = m[1].trim();
    for (let j = i + 1; j < lines.length; j++) {
      const nxt = lines[j];
      if (/^\s{2,}\S/.test(nxt) && nxt.trim() !== "") buf += " " + nxt.trim();
      else break;
    }
    return cleanRecap(buf);
  }
  return null;
}

function extractLastAssistant(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!/^⏺\s+/.test(l)) continue;
    let buf = l.replace(/^⏺\s+/, "").trim();
    for (let j = i + 1; j < lines.length; j++) {
      const nxt = lines[j];
      if (nxt.trim() === "") break;
      if (/^⏺\s+|^\s*⎿|^❯/.test(nxt)) break;
      if (/^\s{2,}/.test(nxt)) buf += " " + nxt.trim();
      else break;
    }
    return buf.trim();
  }
  return null;
}

function detectState(lines: string[]): "running" | "bg" | "idle" {
  const tail = lines.slice(-15).join("\n");
  if (/esc to interrupt|Actioning…|Running…|\(ctrl\+b to run in background\)/.test(tail))
    return "running";
  if (/Command running in background/.test(tail)) return "bg";
  return "idle";
}

function countErrors(lines: string[]): number {
  let n = 0;
  const recent = lines.slice(-80);
  for (const l of recent) {
    if (/\b(error|failed|NOT_FOUND|exit code [1-9])\b/i.test(l)) n++;
  }
  return n;
}

function isQuestion(s: string | null): boolean {
  if (!s) return false;
  return /[?？]\s*$|教えてください[。]?\s*$|ください[。]?\s*$|と言ってください[。]?\s*$/.test(
    s.trim(),
  );
}

function extractWorkedSec(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const m = lines[i].match(WORKED_RE);
    if (m) return (parseInt(m[1] ?? "0", 10) || 0) * 60 + (parseInt(m[2], 10) || 0);
  }
  return null;
}

/** Noise filter — used primarily if diffing against a prior snapshot. */
export function normalizeForDiff(s: string): string {
  const t = s.trimEnd();
  if (!t || SPINNER_RE.test(t) || USER_PROMPT_RE.test(t) || DIVIDER_RE.test(t)) return "";
  return t;
}

export function summarizeTerminal(renderedText: string): TermSummary {
  const lines = renderedText.split("\n");
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length === 0) {
    return {
      state: "empty",
      recap: null,
      lastAssistant: null,
      errorCount: 0,
      waitingForUser: false,
      workedSec: null,
    };
  }
  const recap = extractRecap(lines);
  const lastAssistant = extractLastAssistant(lines);
  const state = detectState(lines);
  return {
    state,
    recap,
    lastAssistant,
    errorCount: countErrors(lines),
    waitingForUser: state === "idle" && (isQuestion(recap) || isQuestion(lastAssistant)),
    workedSec: extractWorkedSec(lines),
  };
}
