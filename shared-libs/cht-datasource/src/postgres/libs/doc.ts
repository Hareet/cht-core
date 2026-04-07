import logger from '@medic/logger';
import { DataObject, Nullable, Page } from '../../libs/core';
import { Doc, isDoc } from '../../libs/doc';
import { PostgresDataContext } from './data-context';

/**
 * Generates a CouchDB-compatible _rev string for documents created/updated in PostgreSQL.
 * Format: `{revNumber}-pg{randomHex}` where revNumber is incremented on each update.
 * @internal
 */
const generateRev = (currentRev?: string): string => {
  const revNum = currentRev
    ? parseInt(currentRev.split('-')[0], 10) + 1
    : 1;
  const suffix = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return `${revNum}-pg${suffix}`;
};

/** @internal */
export const getDocById = (ctx: PostgresDataContext) => async (id: string): Promise<Nullable<Doc>> => {
  try {
    const { rows } = await ctx.pool.query<{ doc: Doc }>(
      `SELECT doc FROM ${ctx.qualifiedTable} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
      [id]
    );
    if (rows.length === 0) {
      return null;
    }
    const doc = rows[0].doc;
    return isDoc(doc) ? doc : null;
  } catch (err: unknown) {
    logger.error(`Failed to fetch doc with id [${id}] from PostgreSQL`, err);
    throw err;
  }
};

/** @internal */
export const getDocsByIds = (ctx: PostgresDataContext) => async (
  ids: (string | undefined)[]
): Promise<Nullable<Doc>[]> => {
  if (!ids.some(Boolean)) {
    return Array.from({ length: ids.length }, () => null);
  }

  const validIds = ids.map(id => id ?? '');
  const { rows } = await ctx.pool.query<{ _id: string, doc: Doc }>(
    `SELECT _id, doc FROM ${ctx.qualifiedTable}
     WHERE _id = ANY($1) AND (_deleted IS NULL OR _deleted = false)`,
    [validIds]
  );

  const docMap = new Map(rows.map(row => [row._id, row.doc]));
  return validIds.map(id => {
    const doc = docMap.get(id);
    return doc && isDoc(doc) ? doc : null;
  });
};

/** @internal */
export const getDocIdsByIdRange = (ctx: PostgresDataContext) => async (
  startkey: string,
  endkey: string,
  limit?: number,
  skip = 0
): Promise<string[]> => {
  let sql = `SELECT _id FROM ${ctx.qualifiedTable}
    WHERE _id >= $1 AND _id <= $2 AND (_deleted IS NULL OR _deleted = false)
    ORDER BY _id`;
  const params: unknown[] = [startkey, endkey];

  if (limit !== undefined) {
    sql += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }
  if (skip > 0) {
    sql += ` OFFSET $${params.length + 1}`;
    params.push(skip);
  }

  const { rows } = await ctx.pool.query<{ _id: string }>(sql, params);
  return rows.map(row => row._id);
};

/**
 * Queries documents by contact type, replicating the `medic-client/contacts_by_type` CouchDB view.
 *
 * CouchDB view sorting: rows with the same key are sorted by document `_id`, NOT by the
 * emitted value. The view emits `[type]` as key and an order string as value, but the value
 * is informational only. Verified against live CouchDB 3.5.0.
 * @internal
 */
export const queryDocsByType = (ctx: PostgresDataContext) => async (
  contactType: string,
  limit: number,
  skip: number
): Promise<Nullable<Doc>[]> => {
  const { rows } = await ctx.pool.query<{ doc: Doc }>(
    `SELECT doc FROM ${ctx.qualifiedTable}
     WHERE COALESCE(doc->>'contact_type', doc->>'type') = $1
       AND (_deleted IS NULL OR _deleted = false)
     ORDER BY _id
     LIMIT $2 OFFSET $3`,
    [contactType, limit, skip]
  );
  return rows.map(row => isDoc(row.doc) ? row.doc : null);
};

/**
 * Queries document IDs by contact type (ID-only variant of queryDocsByType).
 * @internal
 */
export const queryDocIdsByType = (ctx: PostgresDataContext) => async (
  contactType: string,
  limit: number,
  skip: number
): Promise<string[]> => {
  const { rows } = await ctx.pool.query<{ _id: string }>(
    `SELECT _id FROM ${ctx.qualifiedTable}
     WHERE COALESCE(doc->>'contact_type', doc->>'type') = $1
       AND (_deleted IS NULL OR _deleted = false)
     ORDER BY _id
     LIMIT $2 OFFSET $3`,
    [contactType, limit, skip]
  );
  return rows.map(row => row._id);
};

/** @internal */
export const createDoc = (ctx: PostgresDataContext) => async (data: DataObject): Promise<Doc> => {
  const id = crypto.randomUUID();
  const rev = generateRev();
  const doc: Doc = { ...data, _id: id, _rev: rev };

  const { rowCount } = await ctx.pool.query(
    `INSERT INTO ${ctx.qualifiedTable} (_id, doc, saved_timestamp, _deleted, source)
     VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
    [id, JSON.stringify(doc)]
  );
  if (rowCount === 0) {
    throw new Error('Error creating document.');
  }
  return doc;
};

/** @internal */
export const updateDoc = (ctx: PostgresDataContext) => async (data: Doc): Promise<Doc> => {
  const newRev = generateRev(data._rev);
  const doc: Doc = { ...data, _rev: newRev };

  const { rowCount } = await ctx.pool.query(
    `UPDATE ${ctx.qualifiedTable}
     SET doc = $1, saved_timestamp = NOW()
     WHERE _id = $2 AND (_deleted IS NULL OR _deleted = false)`,
    [JSON.stringify(doc), data._id]
  );
  if (rowCount === 0) {
    throw new Error('Error updating document.');
  }
  return doc;
};

/**
 * Resolves a page from a PostgreSQL query function, filtering invalid docs.
 * Mirrors `fetchAndFilter` from local/libs/doc.ts but works with PostgreSQL query functions.
 * @internal
 */
export const fetchAndFilter = <T>(
  getFunction: (limit: number, skip: number) => Promise<Nullable<T>[]>,
  filterFunction: (doc: Nullable<T>) => boolean,
  limit: number,
): typeof recursionInner => {
  const recursionInner = async (
    currentLimit: number,
    currentSkip: number,
    currentDocs: T[] = [],
  ): Promise<Page<T>> => {
    const docs = await getFunction(currentLimit, currentSkip);
    const noMoreResults = docs.length < currentLimit;
    const newDocs = docs.filter((doc): doc is T => filterFunction(doc));
    const overFetchCount = currentDocs.length + newDocs.length - limit || 0;
    const totalDocs = [...currentDocs, ...newDocs].slice(0, limit);

    if (noMoreResults) {
      return { data: totalDocs, cursor: null };
    }
    if (totalDocs.length === limit) {
      const nextSkip = currentSkip + currentLimit - overFetchCount;
      return { data: totalDocs, cursor: nextSkip.toString() };
    }

    const missingCount = currentLimit - newDocs.length;
    logger.debug(`Found [${missingCount.toString()}] invalid docs. Re-fetching additional records.`);
    return recursionInner(missingCount * 2, currentSkip + currentLimit, totalDocs);
  };
  return recursionInner;
};

/** @internal */
export const fetchAndFilterIds = (
  getFunction: (limit: number, skip: number) => Promise<string[]>,
  limit: number,
): ReturnType<typeof fetchAndFilter<string>> => {
  const idSet = new Set<string>();
  const filterFn = (id: Nullable<string>): boolean => {
    if (!id) {
      return false;
    }
    const { size } = idSet;
    idSet.add(id);
    return idSet.size !== size;
  };

  return fetchAndFilter(getFunction, filterFn, limit);
};
