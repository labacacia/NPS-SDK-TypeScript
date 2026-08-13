// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 LabAcacia / INNO LOTUS PTY LTD
//
// @labacacia/nps-sdk — root entry point.
// Mirrors Python root __init__.py: exports only the SDK version.
// All protocol APIs are accessed via sub-package imports:
//   import { ... } from "@labacacia/nps-sdk/core"
//   import { ... } from "@labacacia/nps-sdk/ncp"

import packageMetadata from "../package.json" with { type: "json" };

export const VERSION: string = packageMetadata.version;
