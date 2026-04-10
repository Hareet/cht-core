import { hasField, isRecord, Nullable, Page } from '../libs/core';
import { Doc } from '../libs/doc';
import {
  ContactIdQualifier,
  ContactIdsQualifier,
  IdQualifier,
  isContactIdQualifier,
  ReportingPeriodQualifier,
} from '../qualifier';
import * as Target from '../target';
import { fetchAndFilter, getDocById, getDocIdsByIdRange, getDocsByIds } from './libs/doc';
import { PostgresDataContext } from './libs/data-context';
import logger from '@medic/logger';
import { InvalidArgumentError } from '../libs/error';

const validateCursor = (cursor: Nullable<string>): number => {
  const skip = Number(cursor);
  if (isNaN(skip) || skip < 0 || !Number.isInteger(skip)) {
    throw new InvalidArgumentError(`The cursor must be a string or null for first page: [${JSON.stringify(cursor)}].`);
  }
  return skip;
};

const getTargetIds = async (
  getDocIdsRange: ReturnType<typeof getDocIdsByIdRange>,
  qualifier: ReportingPeriodQualifier & (ContactIdsQualifier | ContactIdQualifier)
) => {
  const contactIdSet = new Set(
    isContactIdQualifier(qualifier) ? [qualifier.contactId] : qualifier.contactIds
  );

  if (contactIdSet.size === 1) {
    const contactId = contactIdSet.values().next().value!;
    return getDocIdsRange(
      `target~${qualifier.reportingPeriod}~${contactId}~`,
      `target~${qualifier.reportingPeriod}~${contactId}~\ufff0`,
    );
  }

  const allTargetIds = await getDocIdsRange(
    `target~${qualifier.reportingPeriod}~`,
    `target~${qualifier.reportingPeriod}~\ufff0`,
  );
  return allTargetIds.filter(id => {
    const [, , contactId] = id.split('~');
    return contactIdSet.has(contactId);
  });
};

/** @internal */
export namespace v1 {
  const isTarget = (doc: Nullable<Doc>): doc is Target.v1.Target => {
    return isRecord(doc)
      && doc.type === 'target'
      && hasField(doc, { name: 'user', type: 'string' })
      && hasField(doc, { name: 'owner', type: 'string' })
      && hasField(doc, { name: 'reporting_period', type: 'string' })
      && hasField(doc, { name: 'updated_date', type: 'number' })
      && Array.isArray(doc.targets);
  };

  /** @internal */
  export const get = (ctx: PostgresDataContext) => {
    const getPgDocById = getDocById(ctx);

    return async (
      { id }: IdQualifier
    ): Promise<Nullable<Target.v1.Target>> => {
      const doc = await getPgDocById(id);
      if (!isTarget(doc)) {
        logger.warn(`Document [${id}] is not a valid target.`);
        return null;
      }
      return doc;
    };
  };

  /** @internal */
  export const getPage = (ctx: PostgresDataContext) => {
    const getDocIdsRange = getDocIdsByIdRange(ctx);
    const getPgDocsByIds = getDocsByIds(ctx);

    return async (
      qualifier: ReportingPeriodQualifier & (ContactIdsQualifier | ContactIdQualifier),
      cursor: Nullable<string>,
      limit: number,
    ): Promise<Page<Target.v1.Target>> => {
      const skip = validateCursor(cursor);
      const targetIds = await getTargetIds(getDocIdsRange, qualifier);
      if (!targetIds.length) {
        return { data: [], cursor: null };
      }

      const getFn = async (limit: number, skip: number) => {
        const ids = targetIds.slice(skip, skip + limit);
        return getPgDocsByIds(ids);
      };
      return fetchAndFilter(
        getFn,
        isTarget,
        limit
      )(limit, skip) as Promise<Page<Target.v1.Target>>;
    };
  };
}
