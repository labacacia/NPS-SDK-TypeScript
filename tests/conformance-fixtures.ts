// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function conformanceFixture(...segments: string[]): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(current, "spec", "conformance", ...segments);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Unable to locate conformance fixture: ${segments.join("/")}`,
  );
}
