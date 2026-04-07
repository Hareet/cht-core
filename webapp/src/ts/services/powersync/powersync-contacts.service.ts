/**
 * PowerSync-backed contacts service for CHT.
 *
 * Provides the same interface as the PouchDB-backed ContactsService but reads from
 * PowerSync's local SQLite instead of PouchDB/CouchDB views.
 *
 * This is a progressive replacement - it can be injected alongside the original
 * ContactsService during the migration period. Components opt in by depending on
 * this service instead of (or in addition to) the original.
 *
 * View query translations:
 *   medic-client/contacts_by_type → SELECT FROM contacts WHERE type IN (...)
 *   medic-client/contacts_by_parent → SELECT FROM contacts WHERE parent_id = ? AND type = ?
 */
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ContactTypesService } from '@mm-services/contact-types.service';
import { PowerSyncService } from './powersync.service';
import type { ContactRow } from './powersync-schema';

@Injectable({
  providedIn: 'root'
})
export class PowerSyncContactsService {
  constructor(
    private powerSync: PowerSyncService,
    private contactTypesService: ContactTypesService,
  ) {}

  /**
   * Get contacts by type(s).
   * Replaces: dbService.get().query('medic-client/contacts_by_type', { key: [type] })
   *
   * Returns documents in the same shape as PouchDB query results (.rows[].doc)
   * but from PowerSync SQLite.
   */
  async get(types: string[]): Promise<any[]> {
    if (!types || !types.length) {
      return Promise.reject(new Error('Call made to Contacts requesting no types'));
    }

    const contacts = await this.powerSync.getContactsByType(types);
    return contacts.map(row => this.toDocument(row));
  }

  /**
   * Watch contacts by type(s) reactively.
   * Returns an Observable that emits the full contact list whenever data changes.
   */
  watch(types: string[]): Observable<any[]> {
    if (!types || !types.length) {
      return new Observable(sub => {
        sub.error(new Error('Call made to Contacts requesting no types'));
      });
    }

    return new Observable(subscriber => {
      const inner = this.powerSync.watchContactsByType(types).subscribe({
        next: (rows) => subscriber.next(rows.map(row => this.toDocument(row))),
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });

      return () => inner.unsubscribe();
    });
  }

  /**
   * Get sibling contacts (same parent and type).
   * Replaces: dbService.get().query('medic-client/contacts_by_parent', { key: [parentId, type] })
   */
  async getSiblings(contact: any): Promise<any[]> {
    const parentId = contact.parent?._id;
    const contactType = this.contactTypesService.getTypeId(contact);

    if (!contactType) {
      return [];
    }

    if (!parentId) {
      const contactTypeConfig = await this.contactTypesService.get(contactType);
      if (Array.isArray(contactTypeConfig?.parents) && contactTypeConfig.parents.length) {
        console.warn(
          `Cannot fetch siblings for a contact with type [${contactType}], but no parent. `
          + `${contactType} is not a top-level contact type and contacts with this type should have a parent.`
        );
        return [];
      }
      return this.get([contactType]);
    }

    const contacts = await this.powerSync.getContactsByParent(parentId, contactType);
    return contacts.map(row => this.toDocument(row));
  }

  /**
   * Get contacts by parent ID.
   * Replaces: dbService.get().query('medic-client/contacts_by_parent', { key: [parentId] })
   */
  async getByParent(parentId: string, type?: string): Promise<any[]> {
    const contacts = await this.powerSync.getContactsByParent(parentId, type);
    return contacts.map(row => this.toDocument(row));
  }

  /**
   * Watch contacts under a specific parent reactively.
   */
  watchByParent(parentId: string, type?: string): Observable<any[]> {
    const sql = type
      ? 'SELECT * FROM contacts WHERE parent_id = ? AND type = ? ORDER BY name'
      : 'SELECT * FROM contacts WHERE parent_id = ? ORDER BY name';
    const params = type ? [parentId, type] : [parentId];

    return new Observable(subscriber => {
      const inner = this.powerSync.watch(sql, params).subscribe({
        next: (rows: any[]) => subscriber.next(rows.map(row => this.toDocument(row))),
        error: (err: any) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });

      return () => inner.unsubscribe();
    });
  }

  /**
   * Convert a PowerSync ContactRow to a CouchDB-style document.
   *
   * This bridges the gap during migration - existing CHT components expect
   * documents with _id, type, and nested parent objects.
   */
  private toDocument(row: ContactRow): any {
    const doc: any = {
      _id: (row as any).id,
      type: row.type || row.doc_type,
      name: row.name,
      phone: row.phone,
      date_of_birth: row.date_of_birth,
      sex: row.sex,
      reported_date: row.reported_date ? Number(row.reported_date) || row.reported_date : undefined,
      notes: row.notes,
      patient_id: row.patient_id,
      contact_type: row.type,
    };

    // Parse parent hierarchy from JSON text
    if (row.parent) {
      try {
        doc.parent = JSON.parse(row.parent);
      } catch {
        doc.parent = row.parent_id ? { _id: row.parent_id } : undefined;
      }
    } else if (row.parent_id) {
      doc.parent = { _id: row.parent_id };
    }

    // Parse geolocation
    if (row.geolocation) {
      try {
        doc.geolocation = JSON.parse(row.geolocation);
      } catch {
        // ignore
      }
    }

    // Handle muted state
    if (row.muted) {
      doc.muted = row.muted;
    }

    // Contact reference (primary contact for places)
    if (row.contact_id) {
      doc.contact = { _id: row.contact_id };
    }

    return doc;
  }
}
