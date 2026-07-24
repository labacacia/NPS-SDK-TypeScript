// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Single-line JSON structured logging for NPS daemons. Port of the .NET
// `NPS.Daemon.Observability.Logging.JsonStructuredLogging` /
// `NpsJsonConsoleFormatter`.
//
// Each record carries the fields the operator runbook expects: `timestamp`,
// `level`, `msg`, `logger`, and (when present) `trace_id`, `event`, `exception`.
// The minimum level is driven by the `NPS_LOG_LEVEL` env var
// (trace/debug/info/warn/error/critical/none — case-insensitive), matching .NET.

/** Env var that overrides the default minimum log level. */
export const LOG_LEVEL_ENV_VAR = "NPS_LOG_LEVEL";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "critical" | "none";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  critical: 5,
  none: 6,
};

/** One structured log record (fields match the .NET JSON formatter). */
export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  msg: string;
  logger: string;
  trace_id?: string;
  event?: { id: number; name?: string };
  exception?: string;
  [extra: string]: unknown;
}

/** Resolves the configured level from `NPS_LOG_LEVEL`, falling back to `fallback`. */
export function resolveLogLevel(fallback: LogLevel = "info", env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env[LOG_LEVEL_ENV_VAR];
  if (!raw || raw.trim() === "") return fallback;
  const norm = normalizeLevel(raw.trim().toLowerCase());
  return norm ?? fallback;
}

/** Serializes a single log record to one line of JSON (no trailing newline). */
export function formatLogRecord(rec: LogRecord): string {
  return JSON.stringify(rec);
}

/**
 * Minimal structured logger. Emits one JSON line per event at/above the
 * configured minimum level. Defaults to writing to stdout, but a custom sink
 * (used by tests) may be supplied.
 */
export class JsonLogger {
  private readonly minLevel: LogLevel;
  private readonly logger: string;
  private readonly sink: (line: string) => void;
  private readonly clock: () => Date;

  constructor(opts: {
    logger?: string;
    level?: LogLevel;
    sink?: (line: string) => void;
    clock?: () => Date;
  } = {}) {
    this.logger = opts.logger ?? "nps";
    this.minLevel = opts.level ?? resolveLogLevel("info");
    this.sink = opts.sink ?? ((line) => process.stdout.write(line + "\n"));
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Returns a child logger with a different category name, sharing config. */
  withCategory(logger: string): JsonLogger {
    return new JsonLogger({ logger, level: this.minLevel, sink: this.sink, clock: this.clock });
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel] && this.minLevel !== "none";
  }

  log(
    level: LogLevel,
    msg: string,
    fields?: {
      traceId?: string;
      event?: { id: number; name?: string };
      exception?: unknown;
      extra?: Record<string, unknown>;
    },
  ): void {
    if (!this.isEnabled(level)) return;
    const rec: LogRecord = {
      timestamp: this.clock().toISOString(),
      level,
      msg,
      logger: this.logger,
    };
    if (fields?.traceId) rec.trace_id = fields.traceId;
    if (fields?.event && (fields.event.id !== 0 || fields.event.name)) rec.event = fields.event;
    if (fields?.exception !== undefined) {
      rec.exception =
        fields.exception instanceof Error
          ? (fields.exception.stack ?? fields.exception.message)
          : String(fields.exception);
    }
    if (fields?.extra) Object.assign(rec, fields.extra);
    this.sink(formatLogRecord(rec));
  }

  trace(msg: string, fields?: Parameters<JsonLogger["log"]>[2]): void {
    this.log("trace", msg, fields);
  }
  debug(msg: string, fields?: Parameters<JsonLogger["log"]>[2]): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: Parameters<JsonLogger["log"]>[2]): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Parameters<JsonLogger["log"]>[2]): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Parameters<JsonLogger["log"]>[2]): void {
    this.log("error", msg, fields);
  }
  critical(msg: string, fields?: Parameters<JsonLogger["log"]>[2]): void {
    this.log("critical", msg, fields);
  }
}

function normalizeLevel(raw: string): LogLevel | null {
  switch (raw) {
    case "trace":
      return "trace";
    case "debug":
      return "debug";
    case "info":
    case "information":
      return "info";
    case "warn":
    case "warning":
      return "warn";
    case "error":
      return "error";
    case "critical":
      return "critical";
    case "none":
      return "none";
    default:
      return null;
  }
}
