import { Doc, isDoc } from '../libs/doc';
import contactTypeUtils from '@medic/contact-types-utils';
import { Nullable, Page } from '../libs/core';
import {
  ContactTypeQualifier,
  FreetextQualifier,
  isContactTypeQualifier,
  isFreetextQualifier,
  UuidQualifier
} from '../qualifier';
import * as Contact from '../contact';
import { fetchAndFilterIds, getDocById, queryDocIdsByType } from './libs/doc';
import { PostgresDataContext } from './libs/data-context';
import { SettingsService } from '../local/libs/data-context';
import logger from '@medic/logger';
import { InvalidArgumentError } from '../libs/error';
import { fetchHydratedDoc } from './libs/lineage';
import { queryByFreetext } from './libs/freetext';

const validateCursor = (cursor: Nullable<string>): number => {
  const skip = Number(cursor);
  if (isNaN(skip) || skip < 0 || !Number.isInteger(skip)) {
    throw new InvalidArgumentError(`The cursor must be a string or null for first page: [${JSON.stringify(cursor)}].`);
  }
  return skip;
};

/** @internal */
export namespace v1 {
  /** @internal */
  export const isContact = (
    settings: SettingsService,
    doc?: Nullable<Doc>
  ): doc is Contact.v1.Contact => {
    if (!isDoc(doc)) {
      return false;
    }
    return contactTypeUtils.isContact(settings.getAll(), doc);
  };

  /** @internal */
  export const get = (ctx: PostgresDataContext) => {
    const getPgDocById = getDocById(ctx);
    return async (identifier: UuidQualifier): Promise<Nullable<Contact.v1.Contact>> => {
      const doc = await getPgDocById(identifier.uuid);
      if (!isContact(ctx.settings, doc)) {
        logger.warn(`Document [${identifier.uuid}] is not a valid contact.`);
        return null;
      }
      return doc;
    };
  };

  /** @internal */
  export const getWithLineage = (ctx: PostgresDataContext) => {
    const fetchHydratedPgDoc = fetchHydratedDoc(ctx);
    return async (identifier: UuidQualifier): Promise<Nullable<Contact.v1.ContactWithLineage>> => {
      const contact = await fetchHydratedPgDoc(identifier.uuid);
      if (!isContact(ctx.settings, contact)) {
        logger.warn(`Document [${identifier.uuid}] is not a valid contact.`);
        return null;
      }
      return contact;
    };
  };

  /** @internal */
  export const getUuidsPage = (ctx: PostgresDataContext) => {
    const queryFreetextFn = queryByFreetext(ctx, 'contacts');
    const queryViewByType = queryDocIdsByType(ctx);

    return async (
      qualifier: ContactTypeQualifier | FreetextQualifier,
      cursor: Nullable<string>,
      limit: number
    ): Promise<Page<string>> => {
      if (isContactTypeQualifier(qualifier)) {
        const contactTypesIds = contactTypeUtils.getContactTypeIds(ctx.settings.getAll());
        if (!contactTypesIds.includes(qualifier.contactType)) {
          throw new InvalidArgumentError(`Invalid contact type [${qualifier.contactType}].`);
        }
      }

      if (!isFreetextQualifier(qualifier)) {
        // Simple contact type query
        const skip = validateCursor(cursor);
        const getPageFn = (limit: number, skip: number) => queryViewByType(
          (qualifier as ContactTypeQualifier).contactType, limit, skip
        );
        return await fetchAndFilterIds(getPageFn, limit)(limit, skip);
      }

      // Freetext search — use PostgreSQL full-text
      const freetextQualifier = {
        ...qualifier,
        freetext: qualifier.freetext.trim().toLowerCase()
      };
      return await queryFreetextFn(freetextQualifier, cursor, limit);
    };
  };
}
