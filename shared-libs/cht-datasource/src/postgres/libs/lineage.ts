import * as Contact from '../../contact';
import * as Person from '../../person';
import {
  DataObject,
  deepCopy,
  findById,
  getLastElement,
  isIdentifiable,
  isNonEmptyArray,
  isNotNull,
  NonEmptyArray,
  NormalizedParent,
  Nullable
} from '../../libs/core';
import { Doc, isDoc } from '../../libs/doc';
import { getDocsByIds } from './doc';
import logger from '@medic/logger';
import { PostgresDataContext } from './data-context';

/**
 * Returns the identified document along with the parent documents recorded for its lineage.
 * Uses a recursive CTE to walk the `doc->'parent'->>'_id'` chain, replicating the
 * `medic-client/docs_by_id_lineage` CouchDB view.
 *
 * The returned array is sorted by depth: the identified document is first (depth 0),
 * followed by parent documents in order of lineage.
 * @internal
 */
export const getLineageDocsById = (ctx: PostgresDataContext) => async (id: string): Promise<Nullable<Doc>[]> => {
  const { rows } = await ctx.pool.query<{ doc: Doc, depth: number }>(
    `WITH RECURSIVE lineage AS (
       SELECT doc, doc->'parent'->>'_id' AS parent_id, 0 AS depth
       FROM ${ctx.qualifiedTable}
       WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)

       UNION ALL

       SELECT c.doc, c.doc->'parent'->>'_id', l.depth + 1
       FROM ${ctx.qualifiedTable} c
       JOIN lineage l ON c._id = l.parent_id
       WHERE l.parent_id IS NOT NULL
         AND l.parent_id != ''
         AND (c._deleted IS NULL OR c._deleted = false)
         AND l.depth < 20
     )
     SELECT doc, depth FROM lineage ORDER BY depth`,
    [id]
  );

  return rows.map(row => isDoc(row.doc) ? row.doc : null);
};

/** @internal */
export const getPrimaryContactIds = (places: NonEmptyArray<Nullable<Doc>>): string[] => places
  .filter(isNotNull)
  .map(({ contact }) => contact)
  .filter(isIdentifiable)
  .map(({ _id }) => _id)
  .filter((_id) => _id.length > 0);

/** @internal */
export const hydratePrimaryContact = (contacts: Doc[]) => (place: Nullable<Doc>): Nullable<Doc> => {
  if (!place || !isIdentifiable(place.contact)) {
    return place;
  }
  const contact = findById(contacts, place.contact._id);
  if (!contact) {
    logger.debug(`No contact found with identifier [${place.contact._id}] for the place [${place._id}].`);
    return place;
  }
  return { ...place, contact };
};

const getParentUuid = (index: number, contact?: NormalizedParent): Nullable<string> => {
  if (!contact) {
    return null;
  }
  if (index === 0) {
    return contact._id;
  }
  return getParentUuid(index - 1, contact.parent);
};

const mergeLineage = (lineage: DataObject[], parent: DataObject): DataObject => {
  if (!isNonEmptyArray(lineage)) {
    return parent;
  }
  const child = getLastElement(lineage);
  const mergedChild = { ...child, parent: parent };
  return mergeLineage(lineage.slice(0, -1), mergedChild);
};

/** @internal */
export const hydrateLineage = (
  contact: Contact.v1.Contact,
  lineage: Nullable<Doc>[]
): Contact.v1.Contact => {
  const fullLineage = lineage
    .map((place, index) => {
      if (place) {
        return place;
      }
      const parentId = getParentUuid(index, contact.parent);
      logger.debug(
        `Lineage place with identifier [${parentId ?? ''}] was not found when getting lineage for [${contact._id}].`
      );
      return { _id: parentId };
    });
  const hierarchy: NonEmptyArray<DataObject> = [contact, ...fullLineage];
  return mergeLineage(hierarchy.slice(0, -1), getLastElement(hierarchy)) as Contact.v1.Contact;
};

/** @internal */
export const getContactLineage = (ctx: PostgresDataContext) => {
  const getMedicDocsById = getDocsByIds(ctx);
  const getDocs = async (uuids: string[]): Promise<Doc[]> => {
    const keys = Array.from(new Set(uuids)).filter(Boolean);
    const docs = await getMedicDocsById(keys);
    return docs.filter(d => d !== null);
  };

  return async (
    places: NonEmptyArray<Nullable<Doc>>,
    person?: Person.v1.Person,
  ): Promise<Nullable<Contact.v1.ContactWithLineage>> => {
    const primaryContactUuids = getPrimaryContactIds(places);
    const uuidsToFetch = person ? primaryContactUuids.filter(uuid => uuid !== person._id) : primaryContactUuids;
    const fetchedContacts = await getDocs(uuidsToFetch);
    const allContacts = person ? [person, ...fetchedContacts] : fetchedContacts;
    const contactsWithHydratedPrimaryContact = places.map(hydratePrimaryContact(allContacts));

    if (person) {
      return deepCopy(hydrateLineage(person, contactsWithHydratedPrimaryContact));
    }

    return deepCopy(hydrateLineage(
      contactsWithHydratedPrimaryContact[0] as Contact.v1.Contact,
      contactsWithHydratedPrimaryContact.slice(1)
    ));
  };
};

/**
 * Fetches a fully hydrated document from PostgreSQL by:
 * 1. Getting the document and its parent lineage via recursive CTE
 * 2. Fetching primary contacts for each place in the lineage
 * 3. Assembling the hydrated document structure
 *
 * This replaces the PouchDB-based `@medic/lineage.fetchHydratedDoc()`.
 * Note: Subject resolution for reports (patient_id/place_id shortcodes) is not yet
 * implemented; that requires the `contacts_by_reference` view equivalent.
 * @internal
 */
export const fetchHydratedDoc = (ctx: PostgresDataContext) => async (uuid: string): Promise<Nullable<Doc>> => {
  const lineageDocs = await getLineageDocsById(ctx)(uuid);
  if (lineageDocs.length === 0 || !lineageDocs[0]) {
    return null;
  }

  const doc = lineageDocs[0];
  if (lineageDocs.length === 1) {
    return doc;
  }

  // Hydrate lineage: fetch primary contacts for all places
  const hydrateContactLineage = getContactLineage(ctx);
  const hydrated = await hydrateContactLineage(
    lineageDocs as NonEmptyArray<Nullable<Doc>>
  );
  return hydrated as Doc;
};

/**
 * Resolves a contact UUID from a shortcode (patient_id, place_id).
 * Replicates the `medic-client/contacts_by_reference` CouchDB view.
 * @internal
 */
export const resolveShortcode = (ctx: PostgresDataContext) => async (
  shortcode: string
): Promise<Nullable<string>> => {
  const { rows } = await ctx.pool.query<{ _id: string }>(
    `SELECT _id FROM ${ctx.qualifiedTable}
     WHERE (_deleted IS NULL OR _deleted = false)
       AND (doc->>'patient_id' = $1
            OR doc->>'place_id' = $1
            OR UPPER(doc->>'rc_code') = UPPER($1))
     LIMIT 1`,
    [shortcode]
  );
  return rows.length > 0 ? rows[0]._id : null;
};
