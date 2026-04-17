import { Doc, isDoc } from '../libs/doc';
import contactTypeUtils from '@medic/contact-types-utils';
import { assertHasRequiredField, Nullable, Page } from '../libs/core';
import { ContactTypeQualifier, UuidQualifier } from '../qualifier';
import * as Place from '../place';
import { createDoc, fetchAndFilter, getDocById, getDocsByIds, minifyDoc, queryDocsByType, updateDoc } from './libs/doc';
import { PostgresDataContext } from './libs/data-context';
import { SettingsService } from '../local/libs/data-context';
import logger from '@medic/logger';
import { InvalidArgumentError, ResourceNotFoundError } from '../libs/error';
import { assertSameParentLineage, fetchHydratedDoc } from './libs/lineage';
import * as Input from '../input';
import * as LocalContact from './contact';

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
  export const isPlace = (settings: SettingsService, doc?: Nullable<Doc>): doc is Place.v1.Place => {
    if (!isDoc(doc)) {
      return false;
    }
    return contactTypeUtils.isPlace(settings.getAll(), doc);
  };

  /** @internal */
  export const get = (ctx: PostgresDataContext) => {
    const getPgDocById = getDocById(ctx);
    return async (identifier: UuidQualifier): Promise<Nullable<Place.v1.Place>> => {
      const doc = await getPgDocById(identifier.uuid);
      if (!isPlace(ctx.settings, doc)) {
        logger.warn(`Document [${identifier.uuid}] is not a valid place.`);
        return null;
      }
      return doc;
    };
  };

  /** @internal */
  export const getWithLineage = (ctx: PostgresDataContext) => {
    const fetchHydratedPgDoc = fetchHydratedDoc(ctx);
    return async (identifier: UuidQualifier): Promise<Nullable<Place.v1.PlaceWithLineage>> => {
      const place = await fetchHydratedPgDoc(identifier.uuid);
      if (!isPlace(ctx.settings, place)) {
        logger.warn(`Document [${identifier.uuid}] is not a valid place.`);
        return null;
      }
      return place;
    };
  };

  /** @internal */
  export const getPage = (ctx: PostgresDataContext) => {
    const getDocsByPage = queryDocsByType(ctx);

    return async (
      placeType: ContactTypeQualifier,
      cursor: Nullable<string>,
      limit: number
    ): Promise<Page<Place.v1.Place>> => {
      const placeTypes = contactTypeUtils.getPlaceTypes(ctx.settings.getAll());
      const placeTypeIds = placeTypes.map((p: { id: string }) => p.id);

      if (!placeTypeIds.includes(placeType.contactType)) {
        throw new InvalidArgumentError(`Invalid contact type [${placeType.contactType}].`);
      }

      const skip = validateCursor(cursor);
      const getDocsByPageWithPlaceType = (
        limit: number,
        skip: number
      ) => getDocsByPage(placeType.contactType, limit, skip);

      return await fetchAndFilter(
        getDocsByPageWithPlaceType,
        (doc: Nullable<Doc>) => isPlace(ctx.settings, doc),
        limit
      )(limit, skip) as Page<Place.v1.Place>;
    };
  };

  /** @internal */
  export const create = (ctx: PostgresDataContext) => {
    const getPgDocsByIds = getDocsByIds(ctx);
    const createPgDoc = createDoc(ctx);

    return async (input: Input.v1.PlaceInput, idHint?: string): Promise<Place.v1.Place> => {
      const settingsData = ctx.settings.getAll();
      const customType = contactTypeUtils.getTypeById(settingsData, input.type);
      const placeType = customType ?? { id: input.type };
      if ((placeType as { person?: boolean }).person) {
        throw new InvalidArgumentError(`[${input.type}] is not a valid place type.`);
      }

      const typeProperties = customType
        ? { contact_type: input.type, type: 'contact' }
        : { type: input.type };

      const [parentDoc, contactDoc] = await getPgDocsByIds([input.parent, input.contact]);

      // Validate parent if required
      const parentPlaceType = customType ?? { id: input.type, parents: undefined };
      if (input.parent && !(parentPlaceType as { parents?: string[] }).parents) {
        throw new InvalidArgumentError(`Place type [${input.type}] does not support having a parent contact.`);
      }
      if (!input.parent && (parentPlaceType as { parents?: string[] }).parents) {
        throw new InvalidArgumentError(`Place type [${input.type}] requires a parent contact.`);
      }

      // Validate primary contact if provided
      if (input.contact && !LocalContact.v1.isContact(ctx.settings, contactDoc)) {
        throw new InvalidArgumentError(`Primary contact [${input.contact}] not found.`);
      }

      const placeDoc = {
        ...input,
        ...typeProperties,
        parent: parentDoc ? { _id: parentDoc._id } : undefined,
        contact: contactDoc ? { _id: contactDoc._id } : undefined,
        reported_date: getReportedDateTimestamp(input.reported_date),
      };
      const created = idHint ? createPgDoc(placeDoc, idHint) : createPgDoc(placeDoc);
      return created as Promise<Place.v1.Place>;
    };
  };

  /** @internal */
  export const update = (ctx: PostgresDataContext) => {
    const getPgDocsByIds = getDocsByIds(ctx);
    const updatePgDoc = updateDoc(ctx);

    return async <T extends Place.v1.Place | Place.v1.PlaceWithLineage>(
      updatedPlace: Input.v1.UpdatePlaceInput<T>
    ): Promise<T> => {
      if (!isPlace(ctx.settings, updatedPlace)) {
        throw new InvalidArgumentError('Valid _id, _rev, and type fields must be provided.');
      }
      const [originalPlace] = await getPgDocsByIds([updatedPlace._id]);
      if (!isPlace(ctx.settings, originalPlace)) {
        throw new ResourceNotFoundError(`Place record [${updatedPlace._id}] not found.`);
      }

      const unchangedFields = ['_rev', 'reported_date', 'type', 'contact_type'];
      const changedFields = unchangedFields.filter(key =>
        (originalPlace as Record<string, unknown>)[key] !== (updatedPlace as Record<string, unknown>)[key]
      );
      if (changedFields.length) {
        throw new InvalidArgumentError(`The [${changedFields}] fields must not be changed.`);
      }
      if (originalPlace.name !== updatedPlace.name) {
        assertHasRequiredField(updatedPlace, { name: 'name', type: 'string' }, InvalidArgumentError);
      }
      assertSameParentLineage(originalPlace, updatedPlace);

      const minified = minifyDoc(updatedPlace as unknown as Doc);
      const { _rev } = await updatePgDoc(minified);
      return { ...updatedPlace, _rev };
    };
  };
}
