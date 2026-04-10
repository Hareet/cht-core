import { Doc, isDoc } from '../libs/doc';
import { hasStringFieldWithValue, Nullable, Page } from '../libs/core';
import { FreetextQualifier, UuidQualifier } from '../qualifier';
import * as Report from '../report';
import * as Input from '../input';
import { createDoc, getDocById, getDocIdsByIdRange, getDocsByIds, minifyDoc, updateDoc } from './libs/doc';
import { PostgresDataContext } from './libs/data-context';
import logger from '@medic/logger';
import { InvalidArgumentError, ResourceNotFoundError } from '../libs/error';
import { fetchHydratedDoc } from './libs/lineage';
import { queryByFreetext } from './libs/freetext';
import * as LocalContact from './contact';

const FORM_DOC_ID_PREFIX = 'form:';

const getReportedDateTimestamp = (reportedDate?: string | number): number => {
  const timestamp = new Date(reportedDate ?? Date.now()).getTime();
  if (Number.isNaN(timestamp)) {
    throw new InvalidArgumentError(`Invalid date value [${reportedDate}].`);
  }
  return timestamp;
};

/** @internal */
export namespace v1 {
  const isReport = (doc: Nullable<Doc>): doc is Report.v1.Report => {
    if (!isDoc(doc)) {
      return false;
    }
    return doc.type === 'data_record' && hasStringFieldWithValue(doc, 'form');
  };

  /** @internal */
  export const get = (ctx: PostgresDataContext) => {
    const getPgDocById = getDocById(ctx);
    return async (identifier: UuidQualifier): Promise<Nullable<Report.v1.Report>> => {
      const doc = await getPgDocById(identifier.uuid);
      if (!isReport(doc)) {
        logger.warn(`Document [${identifier.uuid}] is not a valid report.`);
        return null;
      }
      return doc;
    };
  };

  /** @internal */
  export const getWithLineage = (ctx: PostgresDataContext) => {
    const fetchHydratedPgDoc = fetchHydratedDoc(ctx);
    return async (identifier: UuidQualifier): Promise<Nullable<Report.v1.ReportWithLineage>> => {
      const report = await fetchHydratedPgDoc(identifier.uuid);
      if (!isReport(report)) {
        logger.warn(`Document [${identifier.uuid}] is not a valid report.`);
        return null;
      }
      return report;
    };
  };

  /** @internal */
  export const getUuidsPage = (ctx: PostgresDataContext) => {
    const queryFreetextFn = queryByFreetext(ctx, 'reports');

    return async (
      qualifier: FreetextQualifier,
      cursor: Nullable<string>,
      limit: number
    ): Promise<Page<string>> => {
      const freetextQualifier = {
        ...qualifier,
        freetext: qualifier.freetext.trim().toLowerCase()
      };
      return await queryFreetextFn(freetextQualifier, cursor, limit);
    };
  };

  /** @internal */
  export const create = (ctx: PostgresDataContext) => {
    const createPgDoc = createDoc(ctx);
    const getPgDoc = getDocById(ctx);
    const getPgDocIdsByRange = getDocIdsByIdRange(ctx);

    return async (input: Input.v1.ReportInput): Promise<Report.v1.Report> => {
      // Validate form exists
      const formDocIds = await getPgDocIdsByRange(FORM_DOC_ID_PREFIX, `${FORM_DOC_ID_PREFIX}\ufff0`);
      const supportedForms = formDocIds.map(id => id.substring(FORM_DOC_ID_PREFIX.length));
      if (!supportedForms.includes(input.form)) {
        throw new InvalidArgumentError(`Invalid form value [${input.form}].`);
      }

      // Validate contact
      const contact = await getPgDoc(input.contact);
      if (!LocalContact.v1.isContact(ctx.settings, contact)) {
        throw new InvalidArgumentError(`Contact [${input.contact}] not found.`);
      }

      const reportDoc = {
        ...input,
        contact: { _id: contact._id },
        reported_date: getReportedDateTimestamp(input.reported_date),
        type: 'data_record',
      };
      return createPgDoc(reportDoc) as Promise<Report.v1.Report>;
    };
  };

  /** @internal */
  export const update = (ctx: PostgresDataContext) => {
    const getPgDocsByIds = getDocsByIds(ctx);
    const updatePgDoc = updateDoc(ctx);
    const getPgDocIdsByRange = getDocIdsByIdRange(ctx);

    return async <T extends Report.v1.Report | Report.v1.ReportWithLineage>(
      updatedReport: Input.v1.UpdateReportInput<T>
    ): Promise<T> => {
      if (!isReport(updatedReport)) {
        throw new InvalidArgumentError('Valid _id, _rev, form, and type fields must be provided.');
      }
      const [originalReport] = await getPgDocsByIds([updatedReport._id]);
      if (!isReport(originalReport)) {
        throw new ResourceNotFoundError(`Report record [${updatedReport._id}] not found.`);
      }

      // Check read-only fields
      const unchangedFields = ['_rev', 'reported_date'];
      const changedFields = unchangedFields.filter(key =>
        (originalReport as Record<string, unknown>)[key] !== (updatedReport as Record<string, unknown>)[key]
      );
      if (changedFields.length) {
        throw new InvalidArgumentError(`The [${changedFields}] fields must not be changed.`);
      }

      // Validate form change
      if (originalReport.form !== updatedReport.form) {
        const formDocIds = await getPgDocIdsByRange(FORM_DOC_ID_PREFIX, `${FORM_DOC_ID_PREFIX}\ufff0`);
        const supportedForms = formDocIds.map(id => id.substring(FORM_DOC_ID_PREFIX.length));
        if (!supportedForms.includes(updatedReport.form)) {
          throw new InvalidArgumentError(`Invalid form value [${updatedReport.form}].`);
        }
      }

      const minified = minifyDoc(updatedReport as unknown as Doc);
      const { _rev } = await updatePgDoc(minified);
      return { ...updatedReport, _rev };
    };
  };
}
