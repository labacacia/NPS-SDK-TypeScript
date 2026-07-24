// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Graceful shutdown coordinator for NPS daemons. Port of the .NET
// `NPS.Daemon.Observability.Shutdown` (`GracefulShutdown`, `ShutdownState`,
// `ShutdownLogger`).
//
// On SIGTERM/SIGINT the coordinator (1) flips a liveness gate so `/healthz`
// can start failing early (letting a load balancer drain the endpoint before
// the listener actually closes), (2) runs registered drain callbacks within a
// bounded timeout, and (3) logs signal-received / shutdown-complete lines.

/** Default drain timeout for NPS daemons (NPS-Dev #45): 30s. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** Liveness flag flipped on shutdown; read by health probes. */
export class ShutdownState {
  private _stopping = false;
  get isStopping(): boolean {
    return this._stopping;
  }
  markStopping(): void {
    this._stopping = true;
  }
}

type DrainCallback = (signal: string) => void | Promise<void>;

/**
 * Coordinates graceful shutdown. Register drain callbacks, then either call
 * {@link installSignalHandlers} to hook SIGTERM/SIGINT, or invoke
 * {@link shutdown} directly (tests, custom lifecycles).
 */
export class GracefulShutdown {
  readonly state = new ShutdownState();
  private readonly callbacks: DrainCallback[] = [];
  private readonly drainTimeoutMs: number;
  private readonly onLog?: (msg: string, extra?: Record<string, unknown>) => void;
  private started = false;
  private installed?: () => void;

  constructor(opts: {
    drainTimeoutMs?: number;
    /** Optional log hook (e.g. a JsonLogger.info bound fn). */
    onLog?: (msg: string, extra?: Record<string, unknown>) => void;
  } = {}) {
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.onLog = opts.onLog;
  }

  /** Registers a callback run during drain (e.g. close server, flush stores). */
  onDrain(cb: DrainCallback): this {
    this.callbacks.push(cb);
    return this;
  }

  /** True once shutdown has begun. Wire to `/healthz` via `isStopping`. */
  get isStopping(): boolean {
    return this.state.isStopping;
  }

  /**
   * Runs the shutdown sequence: mark stopping, log, run drain callbacks under a
   * timeout, log complete. Idempotent — a second call is a no-op.
   */
  async shutdown(signal = "manual"): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.state.markStopping();
    this.onLog?.("shutdown signal received; draining for up to " +
      `${Math.round(this.drainTimeoutMs / 1000)}s`, { signal });

    const drain = Promise.allSettled(this.callbacks.map((cb) => Promise.resolve(cb(signal))));
    await Promise.race([drain, delay(this.drainTimeoutMs)]);

    this.onLog?.("shutdown complete", { signal });
  }

  /**
   * Installs process SIGTERM/SIGINT handlers that trigger {@link shutdown}.
   * Returns a disposer that removes the handlers. Node-only.
   */
  installSignalHandlers(): () => void {
    const handler = (sig: NodeJS.Signals) => {
      void this.shutdown(sig);
    };
    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
    this.installed = () => {
      process.off("SIGTERM", handler);
      process.off("SIGINT", handler);
    };
    return this.installed;
  }

  /** Removes any installed signal handlers. */
  dispose(): void {
    this.installed?.();
    this.installed = undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Do not keep the event loop alive solely for the drain timeout.
    if (typeof t.unref === "function") t.unref();
  });
}
