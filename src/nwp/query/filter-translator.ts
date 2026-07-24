// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Translates a NWP filter predicate (NPS-2 §5.2) to a parameterized SQL WHERE
// clause. Port of the .NET `NPS.NWP.MemoryNode.Query.NwpFilterTranslator`.
//
// Validates all field names against the schema to prevent SQL injection.
// The SQL string output matches the .NET reference byte-for-byte at the
// WHERE-clause boundary (`@pN` named parameters, `1=1`/`1=0` empty-IN/NIN,
// `col IN @pN` bound to an array — exactly as Dapper renders it).

import { NWP_QUERY_FIELD_UNKNOWN, NWP_QUERY_FILTER_INVALID } from "../nwp-error-codes.js";
import {
  DatabaseDialect,
  SqlMemoryNodeSchema,
  resolvedColumnName,
  type SqlMemoryNodeField,
} from "./sql-schema.js";

/** Thrown when a NWP filter cannot be translated to SQL. */
export class NwpFilterError extends Error {
  readonly nwpErrorCode: string;
  constructor(message: string, errorCode: string = NWP_QUERY_FILTER_INVALID) {
    super(message);
    this.name = "NwpFilterError";
    this.nwpErrorCode = errorCode;
  }
}

/**
 * Accumulates ordered named Dapper-style parameters (`@p0`, `@p1`, …). Mirrors
 * .NET `Dapper.DynamicParameters` for the subset the translator uses.
 */
export class SqlParameters {
  private readonly values: Record<string, unknown> = {};
  private readonly order: string[] = [];

  add(name: string, value: unknown): void {
    if (!(name in this.values)) this.order.push(name);
    this.values[name] = value;
  }

  get(name: string): unknown {
    return this.values[name];
  }

  /** Parameter names in insertion order. */
  names(): readonly string[] {
    return this.order;
  }

  /** Plain object of all parameters, keyed by name (no `@` prefix). */
  toObject(): Record<string, unknown> {
    return { ...this.values };
  }
}

/**
 * Translates a NWP filter predicate to a parameterized SQL WHERE clause
 * fragment and populates a {@link SqlParameters} bag.
 */
export class NwpFilterTranslator {
  private readonly schema: SqlMemoryNodeSchema;
  private readonly quote: string; // "[" for SQL Server, "\"" for PG
  private paramIndex = 0;

  constructor(schema: SqlMemoryNodeSchema, dialect: DatabaseDialect) {
    this.schema = schema;
    this.quote = dialect === DatabaseDialect.SqlServer ? "[" : '"';
  }

  /**
   * Translates `filter` into a WHERE clause fragment and populates
   * `parameters`. Returns an empty string when `filter` is null/undefined.
   * @throws {NwpFilterError} on unknown field or unsupported operator.
   */
  translate(filter: Record<string, unknown> | null | undefined, parameters: SqlParameters): string {
    this.paramIndex = 0;
    if (filter === null || filter === undefined) return "";
    return this.buildObject(filter, parameters);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private buildObject(obj: Record<string, unknown>, p: SqlParameters): string {
    const clauses: string[] = [];

    for (const [name, value] of Object.entries(obj)) {
      if (name.startsWith("$")) {
        clauses.push(this.buildLogical(name, value, p));
      } else {
        const field = this.validateField(name);
        clauses.push(this.buildFieldCondition(field, value, p));
      }
    }

    if (clauses.length === 0) return "";
    if (clauses.length === 1) return clauses[0]!;
    return `(${clauses.join(" AND ")})`;
  }

  private buildLogical(op: string, value: unknown, p: SqlParameters): string {
    if (!Array.isArray(value))
      throw new NwpFilterError(`Logical operator '${op}' requires an array value.`);

    let separator: string;
    switch (op) {
      case "$and": separator = " AND "; break;
      case "$or":  separator = " OR ";  break;
      default:
        throw new NwpFilterError(`Unknown logical operator '${op}'.`);
    }

    const parts = value
      .map((el) => this.buildObject(el as Record<string, unknown>, p))
      .filter((s) => s.length > 0);

    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0]!;
    return `(${parts.join(separator)})`;
  }

  private buildFieldCondition(field: SqlMemoryNodeField, condition: unknown, p: SqlParameters): string {
    if (condition === null || typeof condition !== "object" || Array.isArray(condition))
      throw new NwpFilterError(
        `Field '${field.name}' condition must be an object (e.g. {"$eq": value}).`,
      );

    const col = this.quoteColumn(resolvedColumnName(field));
    const parts: string[] = [];

    for (const [op, val] of Object.entries(condition as Record<string, unknown>)) {
      if (op === "$in") parts.push(this.buildIn(col, val, p, false));
      else if (op === "$nin") parts.push(this.buildIn(col, val, p, true));
      else if (op === "$between") parts.push(this.buildBetween(col, val, p));
      else parts.push(this.buildSimple(col, op, field.name, val, p));
    }

    return parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`;
  }

  private buildSimple(col: string, op: string, fieldName: string, value: unknown, p: SqlParameters): string {
    const paramName = `p${this.paramIndex++}`;
    switch (op) {
      case "$eq":       p.add(paramName, extractValue(value));            return `${col} = @${paramName}`;
      case "$ne":       p.add(paramName, extractValue(value));            return `${col} <> @${paramName}`;
      case "$lt":       p.add(paramName, extractValue(value));            return `${col} < @${paramName}`;
      case "$lte":      p.add(paramName, extractValue(value));            return `${col} <= @${paramName}`;
      case "$gt":       p.add(paramName, extractValue(value));            return `${col} > @${paramName}`;
      case "$gte":      p.add(paramName, extractValue(value));            return `${col} >= @${paramName}`;
      case "$contains": p.add(paramName, `%${String(extractValue(value))}%`); return `${col} LIKE @${paramName}`;
      default:
        throw new NwpFilterError(`Unknown filter operator '${op}' on field '${fieldName}'.`);
    }
  }

  private buildIn(col: string, arr: unknown, p: SqlParameters, negate: boolean): string {
    if (!Array.isArray(arr))
      throw new NwpFilterError("$in/$nin requires an array value.");

    const values = arr.map(extractValue);
    if (values.length === 0)
      return negate ? "1=1" : "1=0"; // empty IN → always false; empty NIN → always true

    const paramName = `p${this.paramIndex++}`;
    p.add(paramName, values);
    return negate ? `${col} NOT IN @${paramName}` : `${col} IN @${paramName}`;
  }

  private buildBetween(col: string, arr: unknown, p: SqlParameters): string {
    if (!Array.isArray(arr) || arr.length !== 2)
      throw new NwpFilterError("$between requires an array of exactly two values [low, high].");

    const pLow = `p${this.paramIndex++}`;
    const pHigh = `p${this.paramIndex++}`;
    p.add(pLow, extractValue(arr[0]));
    p.add(pHigh, extractValue(arr[1]));
    return `${col} BETWEEN @${pLow} AND @${pHigh}`;
  }

  private validateField(name: string): SqlMemoryNodeField {
    const field = this.schema.getField(name);
    if (!field) throw new NwpFilterError(`Unknown field '${name}'.`, NWP_QUERY_FIELD_UNKNOWN);
    return field;
  }

  private quoteColumn(col: string): string {
    return this.quote === "[" ? `[${col}]` : `"${col}"`;
  }
}

/**
 * Extracts a JS primitive from a filter value, mirroring the .NET
 * `ExtractValue` JsonElement mapping: strings/booleans/null pass through,
 * numbers stay numeric, objects/arrays become their JSON text.
 */
function extractValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean" || t === "number") return value;
  return JSON.stringify(value);
}
