import type { CheckStatus, InternalFixResult, InternalResult } from "./types.js";

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------

// Foreground colors - used for the summary line and inline tags (slow, etc.)
const COLORS: Record<CheckStatus, string> = {
  ok:      "\x1b[32m",
  warn:    "\x1b[33m",
  fail:    "\x1b[31m",
  skipped: "\x1b[90m",
  error:   "\x1b[35m",
};

export const RESET      = "\x1b[0m";
export const BOLD       = "\x1b[1m";
const DIM               = "\x1b[2m";
export const CLEAR_LINE = "\x1b[2K\r"; // erase current line, carriage-return

// Exported so Doctor can colorize group headers and summary parts.
export { COLORS };

// ---------------------------------------------------------------------------
// Badge system - colored background labels instead of Unicode symbols
// ---------------------------------------------------------------------------

const BADGES: Record<CheckStatus, string> = {
  ok:      "[GOOD]",
  warn:    "[WARN]",
  fail:    "[FAIL]",
  skipped: "[SKIPPED]",
  error:   "[ERROR]",
};

// Each entry is bg_color + fg_color (applied together before the label text)
const BADGE_COLORS: Record<CheckStatus, string> = {
  ok:      "\x1b[42m\x1b[30m",   // green bg, black text
  warn:    "\x1b[43m\x1b[30m",   // yellow bg, black text
  fail:    "\x1b[41m\x1b[97m",   // red bg, bright-white text
  skipped: "\x1b[44m\x1b[97m",   // blue bg, bright-white text
  error:   "\x1b[45m\x1b[97m",   // magenta bg, bright-white text
};

// ---------------------------------------------------------------------------
// Fix badge system
// ---------------------------------------------------------------------------

const FIX_BADGES: Record<string, string> = {
  fixed:      "[FIXED]",
  fix_failed: "[FIX FAILED]",
  fix_error:  "[FIX ERROR]",
};

const FIX_BADGE_COLORS: Record<string, string> = {
  fixed:      "\x1b[42m\x1b[30m",   // green bg, black text
  fix_failed: "\x1b[41m\x1b[97m",   // red bg, bright-white text
  fix_error:  "\x1b[45m\x1b[97m",   // magenta bg, bright-white text
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function colorize(text: string, useColor: boolean, code: string): string {
  return useColor ? `${code}${text}${RESET}` : text;
}

function fixBadge(status: string, useColor: boolean): string {
  const label = FIX_BADGES[status] ?? `[${status.toUpperCase()}]`;
  if (!useColor) return label;
  return `${FIX_BADGE_COLORS[status] ?? ""}${label}${RESET}`;
}

export function printFixSection(
  results: InternalResult[],
  { useColor, writeln }: { useColor: boolean; writeln: (s: string) => void },
): void {
  const fixResults = results.filter((r) => r.fix_result != null);
  if (fixResults.length === 0) return;
  writeln("\n" + colorize("[fixes]", useColor, BOLD));
  for (const r of fixResults) {
    const fr = r.fix_result as InternalFixResult;
    const b = fixBadge(fr.status, useColor);
    writeln(`  ${b} ${r.name}: ${fr.message}`);
    if (fr.status === "fix_error" && fr.exc_stack) {
      for (const line of fr.exc_stack.split("\n")) {
        writeln(colorize(`    ${line}`, useColor, DIM));
      }
    }
  }
}

function badge(status: CheckStatus, useColor: boolean): string {
  const label = BADGES[status] ?? `[${status.toUpperCase()}]`;
  if (!useColor) return label;
  return `${BADGE_COLORS[status] ?? ""}${label}${RESET}`;
}

export function printResult(
  r: InternalResult,
  {
    verbose,
    useColor,
    writeln,
  }: { verbose: boolean; useColor: boolean; writeln: (s: string) => void },
): void {
  const b = badge(r.status, useColor);

  if (r.status === "ok") {
    if (r.is_slow) {
      const slowTag = colorize("<- slow", useColor, COLORS.warn);
      writeln(`  ${b} ${r.name} (${Math.round(r.duration_ms)}ms) ${slowTag}`);
    } else if (verbose) {
      writeln(`  ${b} ${r.name}: ${r.message} (${Math.round(r.duration_ms)}ms)`);
    } else {
      writeln(`  ${b} ${r.name}`);
    }
    return;
  }

  if (r.status === "skipped") {
    const reason = r.skip_reason ? ` (${r.skip_reason})` : "";
    writeln(`  ${b} ${colorize(r.name, useColor, DIM)}${reason}`);
    return;
  }

  // fail / warn / error
  const dur = r.duration_ms ? ` (${Math.round(r.duration_ms)}ms)` : "";
  writeln(`  ${b} ${r.name}: ${r.message}${dur}`);
  if (r.hint) {
    writeln(colorize(`    -> ${r.hint}`, useColor, DIM));
  }
  if (r.status === "error" && verbose && r.exc_stack) {
    for (const line of r.exc_stack.split("\n")) {
      writeln(colorize(`    ${line}`, useColor, DIM));
    }
  }
}

// ---------------------------------------------------------------------------
// JUnit XML renderer
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderJunitXml(results: InternalResult[]): string {
  const seenTags: string[] = [];
  const byTag = new Map<string, InternalResult[]>();
  for (const r of results) {
    if (!byTag.has(r.tag)) {
      seenTags.push(r.tag);
      byTag.set(r.tag, []);
    }
    byTag.get(r.tag)!.push(r);
  }

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', "<testsuites>"];

  for (const tag of seenTags) {
    const tagResults = byTag.get(tag)!;
    const failCount = tagResults.filter(
      (r) => r.status === "fail" || r.status === "error",
    ).length;
    const skipCount = tagResults.filter((r) => r.status === "skipped").length;
    const totalTime = tagResults.reduce((s, r) => s + r.duration_ms, 0) / 1000;

    lines.push(
      `  <testsuite name="${escapeXml(tag)}" tests="${tagResults.length}" ` +
        `failures="${failCount}" skipped="${skipCount}" time="${totalTime.toFixed(3)}">`,
    );

    for (const r of tagResults) {
      const t = (r.duration_ms / 1000).toFixed(3);
      lines.push(
        `    <testcase name="${escapeXml(r.name)}" classname="${escapeXml(tag)}" time="${t}">`,
      );

      if (r.status === "skipped") {
        const msg = r.skip_reason ? ` message="${escapeXml(r.skip_reason)}"` : "";
        lines.push(`      <skipped${msg}/>`);
      } else if (r.status === "fail" || r.status === "error") {
        lines.push(`      <failure message="${escapeXml(r.message)}">`);
        if (r.exc_stack) lines.push(escapeXml(r.exc_stack));
        lines.push(`      </failure>`);
      }

      lines.push(`    </testcase>`);
    }

    lines.push(`  </testsuite>`);
  }

  lines.push("</testsuites>");
  return lines.join("\n");
}
