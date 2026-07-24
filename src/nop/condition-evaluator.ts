// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Evaluates CEL-subset condition expressions used in DAG node `condition`
// fields (NPS-5 §3.1.5). TypeScript port of NPS.NOP.NopConditionEvaluator.
//
// Supported syntax:
//   Comparison:    $.node.field > 0.7, $.node.status == "ok", $.n.x != null
//   Boolean logic: &&, ||, !
//   Grouping:      ( expr )
//   Literals:      numbers, quoted strings, true, false, null
//   JSONPath:      $.node_id.field.sub (via input-mapper resolvePath)

import { resolvePath } from "./input-mapper.js";

/** Thrown when a condition expression cannot be parsed or evaluated. */
export class NopConditionError extends Error {
  constructor(message: string, expression: string) {
    super(`${message}  Expression: «${expression}»`);
    this.name = "NopConditionError";
  }
}

/**
 * Evaluates `condition` in the context of completed node results.
 * Returns `true` if the node should execute; `false` if it should be skipped.
 * @throws {NopConditionError} for syntax errors or unresolvable paths.
 */
export function evaluateCondition(
  condition: string,
  context: ReadonlyMap<string, unknown>,
): boolean {
  if (condition == null || condition.trim().length === 0) return true;

  try {
    const tokens = tokenize(condition.trim());
    return new ConditionParser(tokens, context).parseOrExpr();
  } catch (err) {
    if (err instanceof NopConditionError) throw err;
    throw new NopConditionError(
      `Condition evaluation error: ${(err as Error).message}`,
      condition,
    );
  }
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

enum TokenKind {
  DollarPath,
  Number,
  String,
  True,
  False,
  Null,
  Gt,
  Gte,
  Lt,
  Lte,
  Eq,
  Neq,
  And,
  Or,
  Not,
  LParen,
  RParen,
  Eof,
}

interface Token {
  kind: TokenKind;
  raw: string;
}

function isLetter(c: string): boolean {
  return /[A-Za-z]/.test(c);
}
function isLetterOrDigit(c: string): boolean {
  return /[A-Za-z0-9]/.test(c);
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const c = input[i];

    // Whitespace
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // Dollar path
    if (c === "$" && i + 1 < input.length && input[i + 1] === ".") {
      const start = i;
      while (
        i < input.length &&
        (isLetterOrDigit(input[i]) || input[i] === "_" || input[i] === "." || input[i] === "$")
      )
        i++;
      tokens.push({ kind: TokenKind.DollarPath, raw: input.slice(start, i) });
      continue;
    }

    // String literal
    if (c === '"') {
      const start = i++;
      while (i < input.length && input[i] !== '"') i++;
      i++; // closing quote
      tokens.push({ kind: TokenKind.String, raw: input.slice(start + 1, i - 1) });
      continue;
    }

    // Number
    if (isDigit(c) || (c === "-" && i + 1 < input.length && isDigit(input[i + 1]))) {
      const start = i;
      if (input[i] === "-") i++;
      while (i < input.length && (isDigit(input[i]) || input[i] === ".")) i++;
      tokens.push({ kind: TokenKind.Number, raw: input.slice(start, i) });
      continue;
    }

    // Two-char operators
    const two = input.slice(i, i + 2);
    if (two === ">=") { tokens.push({ kind: TokenKind.Gte, raw: ">=" }); i += 2; continue; }
    if (two === "<=") { tokens.push({ kind: TokenKind.Lte, raw: "<=" }); i += 2; continue; }
    if (two === "==") { tokens.push({ kind: TokenKind.Eq,  raw: "==" }); i += 2; continue; }
    if (two === "!=") { tokens.push({ kind: TokenKind.Neq, raw: "!=" }); i += 2; continue; }
    if (two === "&&") { tokens.push({ kind: TokenKind.And, raw: "&&" }); i += 2; continue; }
    if (two === "||") { tokens.push({ kind: TokenKind.Or,  raw: "||" }); i += 2; continue; }

    // Single-char operators
    if (c === ">") { tokens.push({ kind: TokenKind.Gt,  raw: ">" }); i++; continue; }
    if (c === "<") { tokens.push({ kind: TokenKind.Lt,  raw: "<" }); i++; continue; }
    if (c === "!") { tokens.push({ kind: TokenKind.Not, raw: "!" }); i++; continue; }
    if (c === "(") { tokens.push({ kind: TokenKind.LParen, raw: "(" }); i++; continue; }
    if (c === ")") { tokens.push({ kind: TokenKind.RParen, raw: ")" }); i++; continue; }

    // Keywords: true, false, null
    if (isLetter(c)) {
      const start = i;
      while (i < input.length && isLetterOrDigit(input[i])) i++;
      const kw = input.slice(start, i);
      if (kw === "true") tokens.push({ kind: TokenKind.True, raw: "true" });
      else if (kw === "false") tokens.push({ kind: TokenKind.False, raw: "false" });
      else if (kw === "null") tokens.push({ kind: TokenKind.Null, raw: "null" });
      else throw new NopConditionError(`Unknown token '${kw}'.`, input);
      continue;
    }

    throw new NopConditionError(`Unexpected character '${c}' at position ${i}.`, input);
  }

  tokens.push({ kind: TokenKind.Eof, raw: "" });
  return tokens;
}

// ── Recursive-descent parser ──────────────────────────────────────────────────

type Value = { kind: TokenKind; value: unknown };

class ConditionParser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly context: ReadonlyMap<string, unknown>,
  ) {}

  private get current(): Token {
    return this.tokens[this.pos];
  }
  private consume(): Token {
    return this.tokens[this.pos++];
  }

  // or_expr := and_expr ('||' and_expr)*
  parseOrExpr(): boolean {
    let left = this.parseAndExpr();
    while (this.current.kind === TokenKind.Or) {
      this.consume();
      const right = this.parseAndExpr();
      left = left || right;
    }
    return left;
  }

  // and_expr := not_expr ('&&' not_expr)*
  private parseAndExpr(): boolean {
    let left = this.parseNotExpr();
    while (this.current.kind === TokenKind.And) {
      this.consume();
      const right = this.parseNotExpr();
      left = left && right;
    }
    return left;
  }

  // not_expr := '!' not_expr | comparison
  private parseNotExpr(): boolean {
    if (this.current.kind === TokenKind.Not) {
      this.consume();
      return !this.parseNotExpr();
    }
    return this.parseComparison();
  }

  // comparison := '(' or_expr ')' | true | false | value (op value)?
  private parseComparison(): boolean {
    if (this.current.kind === TokenKind.LParen) {
      this.consume();
      const inner = this.parseOrExpr();
      if ((this.current.kind as TokenKind) !== TokenKind.RParen)
        throw new NopConditionError("Expected ')'.", "");
      this.consume();
      return inner;
    }

    if (this.current.kind === TokenKind.True) { this.consume(); return true; }
    if (this.current.kind === TokenKind.False) { this.consume(); return false; }

    const lhs = this.parseValue();
    const opKind = this.current.kind;
    if (!ConditionParser.isComparisonOp(opKind)) return ConditionParser.asTruthy(lhs);

    this.consume();
    const rhs = this.parseValue();
    return ConditionParser.compare(lhs, opKind, rhs);
  }

  private static isComparisonOp(k: TokenKind): boolean {
    return (
      k === TokenKind.Gt ||
      k === TokenKind.Gte ||
      k === TokenKind.Lt ||
      k === TokenKind.Lte ||
      k === TokenKind.Eq ||
      k === TokenKind.Neq
    );
  }

  // value := dollar_path | number | string | null | true | false
  private parseValue(): Value {
    const tok = this.consume();
    switch (tok.kind) {
      case TokenKind.DollarPath: return { kind: tok.kind, value: this.resolve(tok.raw) };
      case TokenKind.Number:     return { kind: tok.kind, value: Number(tok.raw) };
      case TokenKind.String:     return { kind: tok.kind, value: tok.raw };
      case TokenKind.True:       return { kind: tok.kind, value: true };
      case TokenKind.False:      return { kind: tok.kind, value: false };
      case TokenKind.Null:       return { kind: tok.kind, value: null };
      default:
        throw new NopConditionError(`Expected a value, got '${tok.raw}'.`, "");
    }
  }

  private resolve(path: string): unknown {
    const v = resolvePath(path, this.context);
    if (v === undefined || v === null) return null;
    if (typeof v === "object") return JSON.stringify(v); // object/array as string
    return v; // number, string, boolean
  }

  private static asTruthy(v: Value): boolean {
    const x = v.value;
    if (typeof x === "boolean") return x;
    if (typeof x === "number") return x !== 0;
    if (typeof x === "string") return x.length > 0;
    if (x === null || x === undefined) return false;
    return true;
  }

  private static compare(lhs: Value, op: TokenKind, rhs: Value): boolean {
    const a = lhs.value;
    const b = rhs.value;

    if (op === TokenKind.Eq) return ConditionParser.eq(a, b);
    if (op === TokenKind.Neq) return !ConditionParser.eq(a, b);
    if (a === null || a === undefined || b === null || b === undefined) return false;

    if (typeof a === "number" && typeof b === "number") {
      switch (op) {
        case TokenKind.Gt:  return a > b;
        case TokenKind.Gte: return a >= b;
        case TokenKind.Lt:  return a < b;
        case TokenKind.Lte: return a <= b;
        default: return false;
      }
    }

    if (typeof a === "string" && typeof b === "string") {
      const cmp = a < b ? -1 : a > b ? 1 : 0;
      switch (op) {
        case TokenKind.Gt:  return cmp > 0;
        case TokenKind.Gte: return cmp >= 0;
        case TokenKind.Lt:  return cmp < 0;
        case TokenKind.Lte: return cmp <= 0;
        default: return false;
      }
    }

    return false;
  }

  private static eq(a: unknown, b: unknown): boolean {
    // Mirror .NET Equals semantics for the boxed value types produced by the parser.
    if (a === null || a === undefined) return b === null || b === undefined;
    return a === b;
  }
}
