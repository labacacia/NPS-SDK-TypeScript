// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// SQL-facing Memory Node schema types (NPS-2 §4.1). Port of the .NET
// `NPS.NWP.MemoryNode.MemoryNodeField` / `MemoryNodeSchema` used by the
// filter→SQL translator and SQL query builder.
//
// This is distinct from the wire-facing `MemoryNodeSchema` in
// `memory-server.ts` (which only carries `fields`); the SQL layer needs the
// table name, primary key, and per-field DB column mapping.

/** Supported SQL dialects for quoting and pagination syntax. */
export enum DatabaseDialect {
  SqlServer  = "SqlServer",
  PostgreSql = "PostgreSql",
}

/** Describes a single field in a Memory Node schema (NPS-2 §4.1). */
export interface SqlMemoryNodeField {
  /** Column / property name as exposed in NWP responses. */
  name: string;
  /** NWP field type: "string" | "number" | "boolean" | "datetime" | "object". */
  type: string;
  /** Human-readable description surfaced in the AnchorFrame schema. */
  description?: string;
  /** Whether this field may be null. Default true. */
  nullable?: boolean;
  /** Underlying DB column name, if different from `name`. Defaults to `name`. */
  columnName?: string;
}

/** Resolved column name (falls back to `name`). */
export function resolvedColumnName(field: SqlMemoryNodeField): string {
  return field.columnName ?? field.name;
}

/**
 * Schema definition for a Memory Node — describes the DB table it exposes.
 * Field lookup is case-insensitive, matching the .NET `OrdinalIgnoreCase`.
 */
export class SqlMemoryNodeSchema {
  readonly tableName: string;
  readonly primaryKey: string;
  readonly fields: readonly SqlMemoryNodeField[];

  constructor(init: {
    tableName: string;
    primaryKey: string;
    fields: readonly SqlMemoryNodeField[];
  }) {
    this.tableName = init.tableName;
    this.primaryKey = init.primaryKey;
    this.fields = init.fields;
  }

  /** Returns the field descriptor for `name`, or undefined. */
  getField(name: string): SqlMemoryNodeField | undefined {
    const lower = name.toLowerCase();
    return this.fields.find((f) => f.name.toLowerCase() === lower);
  }

  /** Returns true if `name` is a declared field. */
  hasField(name: string): boolean {
    return this.getField(name) !== undefined;
  }
}
