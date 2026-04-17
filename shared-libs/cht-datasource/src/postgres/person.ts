import { Doc, isDoc } from '../libs/doc';
import contactTypeUtils from '@medic/contact-types-utils';
import { assertHasRequiredField, Nullable, Page } from '../libs/core';
import * as Qualifier from '../qualifier';
import { ContactTypeQualifier, UuidQualifier } from '../qualifier';
import * as Person from '../person';
import { createDoc, fetchAndFilter, getDocById, minifyDoc, queryDocsByType, updateDoc } from './libs/doc';
import { PostgresDataContext } from './libs/data-context';
import { SettingsService } from '../local/libs/data-context';
import logger from '@medic/logger';
import { InvalidArgumentError, ResourceNotFoundError } from '../libs/error';
import { assertSameParentLineage, fetchHydratedDoc } from './libs/lineage';
import * as Input from '../input';

const validateCursor = (cursor: Nullable<string>): number => {
  const skip = Number(cursor);
  if (isNaN(skip) || skip < 0 || !Number.isInteger(skip)) {
    throw new InvalidArgumentError(`The cursor must be a string or null for first page: [${JSON.stringify(cursor)}].`);
  }
  return skip;
};

const getReportedDateTimestamp = (reportedDate?: string | number): number => {
  const timestamp = new Date(reportedDate ?? Date.now()).getTime();
  if (Number.isNaN(timestamp)) {
    throw new InvalidArgumentError(`Invalid date value [${reportedDate}].`);
  }
  return timestamp;
};

/** @internal */
export namespace v1 {
  /** @internal */
  export const isPerson = (
    settings: SettingsService,
    doc: Nullable<Doc>,
  ): doc is Person.v1.Person => {
    if (!isDoc(doc)) {
      return false;
    }
    return contactTypeUtils.isPerson(settings.getAll(), doc);
  };

  /** @internal */
  export const get = (ctx: PostgresDataContext) => {
    const getPgDocById = getDocById(ctx);
    return async (identifier: UuidQualifier): Promise<Nullable<Person.v1.Person>> => {
      const doc = await getPgDocById(identifier.uuid);
      if (!isPerson(ctx.settings, doc)) {
        logger.warn(`Document [${identifier.uuid}] is not a valid person.`);
        return null;
      }
      return doc;
    };
  };

  /** @internal */
  export const getWithLineage = (ctx: PostgresDataContext) => {
    const fetchHydratedPgDoc = fetchHydratedDoc(ctx);
    return async (identifier: UuidQualifier): Promise<Nullable<Person.v1.PersonWithLineage>> => {
      const person = await fetchHydratedPgDoc(identifier.uuid);
      if (!isPerson(ctx.settings, person)) {
        logger.warn(`Document [${identifier.uuid}] is not a valid person.`);
        return null;
      }
      return person;
    };
  };

  /** @internal */
  export const getPage = (ctx: PostgresDataContext) => {
    const getDocsByPage = queryDocsByType(ctx);

    return async (
      personType: ContactTypeQualifier,
      cursor: Nullable<string>,
      limit: number,
    ): Promise<Page<Person.v1.Person>> => {
      const personTypes = contactTypeUtils.getPersonTypes(ctx.settings.getAll());
      const personTypesIds = personTypes.map((item: { id: string }) => item.id);

      if (!personTypesIds.includes(personType.contactType)) {
        throw new InvalidArgumentError(`Invalid contact type [${personType.contactType}].`);
      }

      const skip = validateCursor(cursor);
      const getDocsByPageWithPersonType = (
        limit: number,
        skip: number
      ) => getDocsByPage(personType.contactType, limit, skip);

      return await fetchAndFilter(
        getDocsByPageWithPersonType,
        (doc: Nullable<Doc>) => isPerson(ctx.settings, doc),
        limit
      )(limit, skip) as Page<Person.v1.Person>;
    };
  };

  /** @internal */
  export const create = (ctx: PostgresDataContext) => {
    const createPgDoc = createDoc(ctx);
    const getPgDoc = getDocById(ctx);

    return async (input: Input.v1.PersonInput, idHint?: string): Promise<Person.v1.Person> => {
      const settingsData = ctx.settings.getAll();
      const customType = contactTypeUtils.getTypeById(settingsData, input.type);
      if (!contactTypeUtils.isPersonType(customType ?? { id: input.type })) {
        throw new InvalidArgumentError(`[${input.type}] is not a valid person type.`);
      }
      const typeProperties = customType
        ? { contact_type: input.type, type: 'contact' }
        : { type: input.type };

      const parent = await getPgDoc(input.parent);
      if (!parent) {
        throw new InvalidArgumentError(`Parent contact [${input.parent}] not found.`);
      }

      const personDoc = {
        ...input,
        ...typeProperties,
        parent: { _id: parent._id },
        reported_date: getReportedDateTimestamp(input.reported_date),
      };
      const created = idHint ? createPgDoc(personDoc, idHint) : createPgDoc(personDoc);
      return created as Promise<Person.v1.Person>;
    };
  };

  /** @internal */
  export const update = (ctx: PostgresDataContext) => {
    const updatePgDoc = updateDoc(ctx);
    const getPerson = get(ctx);

    return async <T extends Input.v1.UpdatePersonInput>(updatedPerson: T): Promise<T> => {
      if (!isPerson(ctx.settings, updatedPerson)) {
        throw new InvalidArgumentError('Valid _id, _rev, and type fields must be provided.');
      }
      const originalPerson = await getPerson(Qualifier.byUuid(updatedPerson._id));
      if (!originalPerson) {
        throw new ResourceNotFoundError(`Person record [${updatedPerson._id}] not found.`);
      }

      const unchangedFields = ['_rev', 'reported_date', 'type', 'contact_type'];
      const changedFields = unchangedFields.filter(key =>
        (originalPerson as Record<string, unknown>)[key] !== (updatedPerson as Record<string, unknown>)[key]
      );
      if (changedFields.length) {
        throw new InvalidArgumentError(`The [${changedFields}] fields must not be changed.`);
      }
      if (originalPerson.name) {
        assertHasRequiredField(updatedPerson, { name: 'name', type: 'string' }, InvalidArgumentError);
      }
      assertSameParentLineage(originalPerson, updatedPerson);

      const minified = minifyDoc(updatedPerson);
      const { _rev } = await updatePgDoc(minified);
      return { ...updatedPerson, _rev };
    };
  };
}
