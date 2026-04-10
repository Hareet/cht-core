import { Nullable, Page } from '../../libs/core';
import { ContactTypeQualifier, FreetextQualifier, isContactTypeQualifier, isKeyedFreetextQualifier } from '../../qualifier';
import { PostgresDataContext } from './data-context';
import { InvalidArgumentError } from '../../libs/error';

/**
 * Validates that a freetext search key contains only safe characters for use in JSONB path
 * expressions. Prevents SQL injection via the key portion of keyed freetext queries (e.g. "key:value").
 * Only alphanumeric characters, underscores, and hyphens are allowed — these cover all valid
 * CHT document field names.
 * @internal
 */
const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
const assertSafeKey = (key: string): void => {
  if (!key || !SAFE_KEY_PATTERN.test(key)) {
    throw new InvalidArgumentError(`Invalid freetext search key [${key}].`);
  }
};

/**
 * Builds a PostgreSQL full-text search query that replicates Nouveau/offline freetext indexes.
 *
 * - Keyed freetext (`key:value`): exact match on `doc->>'{key}' = '{value}'`
 * - Unkeyed freetext: prefix search using `doc::text ILIKE '%{term}%'`
 *
 * For contacts, can be combined with a contact type filter.
 * @internal
 */
export const queryByFreetext = (
  ctx: PostgresDataContext,
  docTypeFilter: string,
) => async (
  qualifier: FreetextQualifier & Partial<ContactTypeQualifier>,
  cursor: Nullable<string>,
  limit: number
): Promise<Page<string>> => {
  const params: unknown[] = [];
  const conditions: string[] = [];

  // Base document type filter
  if (docTypeFilter === 'contacts') {
    conditions.push(
      `(doc->>'type' IN ('contact', 'clinic', 'district_hospital', 'health_center', 'person'))`
    );
  } else if (docTypeFilter === 'reports') {
    conditions.push(`doc->>'type' = 'data_record'`);
    conditions.push(`doc->>'form' IS NOT NULL`);
    conditions.push(`doc->>'form' != ''`);
  }

  conditions.push(`(_deleted IS NULL OR _deleted = false)`);

  // Contact type filter (if present)
  if (isContactTypeQualifier(qualifier)) {
    params.push(qualifier.contactType);
    conditions.push(`COALESCE(doc->>'contact_type', doc->>'type') = $${params.length}`);
  }

  // Freetext filter
  if (isKeyedFreetextQualifier(qualifier)) {
    // Keyed: exact match "key:value"
    const colonIdx = qualifier.freetext.indexOf(':');
    const key = qualifier.freetext.slice(0, colonIdx);
    const value = qualifier.freetext.slice(colonIdx + 1);
    assertSafeKey(key);
    params.push(value);
    // Search in both top-level and nested fields
    conditions.push(`(doc->>'${key}' = $${params.length} OR doc->'fields'->>'${key}' = $${params.length})`);
  } else {
    // Unkeyed: ILIKE prefix search
    params.push(`%${qualifier.freetext}%`);
    conditions.push(`doc::text ILIKE $${params.length}`);
  }

  // Pagination
  const skip = cursor ? parseInt(cursor, 10) : 0;
  params.push(limit);
  params.push(skip);

  const sortColumn = docTypeFilter === 'reports'
    ? `(doc->>'reported_date')::bigint DESC NULLS LAST`
    : `LOWER(doc->>'name')`;

  const sql = `SELECT _id FROM ${ctx.qualifiedTable}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${sortColumn}
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const { rows } = await ctx.pool.query<{ _id: string }>(sql, params);
  const data = rows.map(row => row._id);
  const nextCursor = data.length < limit ? null : (skip + limit).toString();

  return { data, cursor: nextCursor };
};
