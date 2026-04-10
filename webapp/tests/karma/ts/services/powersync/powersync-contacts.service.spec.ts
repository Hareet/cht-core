import { TestBed } from '@angular/core/testing';
import sinon from 'sinon';
import { expect } from 'chai';
import { of, throwError } from 'rxjs';

import { PowerSyncContactsService } from '@mm-services/powersync/powersync-contacts.service';
import { PowerSyncService } from '@mm-services/powersync/powersync.service';
import { ContactTypesService } from '@mm-services/contact-types.service';

describe('PowerSync Contacts Service', () => {
  let service: PowerSyncContactsService;
  let powerSyncService: any;
  let contactTypesService: any;

  beforeEach(() => {
    powerSyncService = {
      getContactsByType: sinon.stub().resolves([]),
      getContactsByParent: sinon.stub().resolves([]),
      watchContactsByType: sinon.stub().returns(of([])),
      watch: sinon.stub().returns(of([])),
    };

    contactTypesService = {
      getTypeId: sinon.stub(),
      get: sinon.stub().resolves(null),
    };

    TestBed.configureTestingModule({
      providers: [
        PowerSyncContactsService,
        { provide: PowerSyncService, useValue: powerSyncService },
        { provide: ContactTypesService, useValue: contactTypesService },
      ],
    });

    service = TestBed.inject(PowerSyncContactsService);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('get', () => {
    it('should reject when no types provided', async () => {
      try {
        await service.get([]);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('no types');
      }
    });

    it('should reject when types is null', async () => {
      try {
        await service.get(null as any);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('no types');
      }
    });

    it('should fetch contacts by type and convert to documents', async () => {
      const mockRows = [
        {
          id: 'contact-1',
          type: 'contact',           // v3.7+ uses 'contact'
          contact_type: 'person',    // resolved type
          name: 'John Doe',
          phone: '+254712345678',
          alternative_phone: '+254700000000',
          parent_id: 'clinic-1',
          parent: '{"_id":"clinic-1","type":"clinic"}',
          patient_id: 'P001',
          place_id: null,
          reported_date: '1680000000000',
          active: 'true',
          date_of_death: null,
        },
        {
          id: 'contact-2',
          type: 'contact',
          contact_type: 'person',
          name: 'Jane Smith',
          phone: '+254787654321',
          alternative_phone: null,
          parent_id: 'clinic-1',
          parent: null,
          patient_id: 'P002',
          place_id: null,
          reported_date: '1680001000000',
          active: null,
          date_of_death: null,
        },
      ];
      powerSyncService.getContactsByType.resolves(mockRows);

      const results = await service.get(['person']);

      expect(powerSyncService.getContactsByType.calledOnce).to.be.true;
      expect(powerSyncService.getContactsByType.firstCall.args[0]).to.deep.equal(['person']);
      expect(results.length).to.equal(2);

      // Verify CouchDB document shape with v3.7+ fields
      expect(results[0]._id).to.equal('contact-1');
      expect(results[0].type).to.equal('contact');
      expect(results[0].contact_type).to.equal('person');
      expect(results[0].name).to.equal('John Doe');
      expect(results[0].phone).to.equal('+254712345678');
      expect(results[0].alternative_phone).to.equal('+254700000000');
      expect(results[0].patient_id).to.equal('P001');
      expect(results[0].is_active).to.equal('true');
      expect(results[0].parent).to.deep.equal({ _id: 'clinic-1', type: 'clinic' });

      // Second contact has no parent JSON, should fall back to parent_id
      expect(results[1]._id).to.equal('contact-2');
      expect(results[1].parent).to.deep.equal({ _id: 'clinic-1' });
    });

    it('should handle multiple types', async () => {
      powerSyncService.getContactsByType.resolves([]);

      await service.get(['person', 'clinic', 'health_center']);

      expect(powerSyncService.getContactsByType.firstCall.args[0]).to.deep.equal([
        'person', 'clinic', 'health_center'
      ]);
    });
  });

  describe('watch', () => {
    it('should error for empty types', (done) => {
      service.watch([]).subscribe({
        error: (err) => {
          expect(err.message).to.include('no types');
          done();
        },
      });
    });

    it('should transform rows to documents', (done) => {
      const mockRows = [{
        id: 'c1',
        type: 'contact',
        contact_type: 'clinic',
        name: 'Test Clinic',
        parent_id: null,
        parent: null,
      }];
      powerSyncService.watchContactsByType.returns(of(mockRows));

      service.watch(['clinic']).subscribe({
        next: (docs) => {
          expect(docs.length).to.equal(1);
          expect(docs[0]._id).to.equal('c1');
          expect(docs[0].name).to.equal('Test Clinic');
          done();
        },
      });
    });
  });

  describe('getSiblings', () => {
    it('should return empty array for contacts with no type', async () => {
      contactTypesService.getTypeId.returns(null);

      const result = await service.getSiblings({ parent: { _id: 'p1' } });
      expect(result).to.deep.equal([]);
    });

    it('should fetch all contacts of type when no parent', async () => {
      contactTypesService.getTypeId.returns('district_hospital');
      contactTypesService.get.resolves({ id: 'district_hospital', parents: [] });
      powerSyncService.getContactsByType.resolves([
        { id: 'dh1', type: 'contact', contact_type: 'district_hospital', name: 'Hospital A', parent_id: null, parent: null },
      ]);

      const result = await service.getSiblings({ type: 'district_hospital' });

      expect(result.length).to.equal(1);
      expect(result[0]._id).to.equal('dh1');
    });

    it('should warn and return empty for non-top-level contacts without parent', async () => {
      contactTypesService.getTypeId.returns('clinic');
      contactTypesService.get.resolves({ id: 'clinic', parents: ['health_center'] });

      const warnStub = sinon.stub(console, 'warn');
      const result = await service.getSiblings({ type: 'clinic' });

      expect(result).to.deep.equal([]);
      expect(warnStub.calledOnce).to.be.true;
    });

    it('should fetch siblings by parent and type', async () => {
      contactTypesService.getTypeId.returns('person');
      powerSyncService.getContactsByParent.resolves([
        { id: 'p1', type: 'contact', contact_type: 'person', name: 'Sibling 1', parent_id: 'clinic-1', parent: null },
        { id: 'p2', type: 'contact', contact_type: 'person', name: 'Sibling 2', parent_id: 'clinic-1', parent: null },
      ]);

      const result = await service.getSiblings({
        parent: { _id: 'clinic-1' },
        type: 'person',
      });

      expect(powerSyncService.getContactsByParent.calledOnce).to.be.true;
      expect(powerSyncService.getContactsByParent.firstCall.args).to.deep.equal(['clinic-1', 'person']);
      expect(result.length).to.equal(2);
    });
  });

  describe('getByParent', () => {
    it('should fetch contacts by parent ID', async () => {
      powerSyncService.getContactsByParent.resolves([
        { id: 'c1', type: 'contact', contact_type: 'person', name: 'Child', parent_id: 'p1', parent: null },
      ]);

      const result = await service.getByParent('p1');

      expect(powerSyncService.getContactsByParent.calledWith('p1', undefined)).to.be.true;
      expect(result.length).to.equal(1);
      expect(result[0]._id).to.equal('c1');
    });

    it('should filter by type when provided', async () => {
      powerSyncService.getContactsByParent.resolves([]);

      await service.getByParent('p1', 'clinic');

      expect(powerSyncService.getContactsByParent.calledWith('p1', 'clinic')).to.be.true;
    });
  });

  describe('watchByParent', () => {
    it('should watch contacts under a parent', (done) => {
      const mockRows = [{
        id: 'c1', type: 'contact', contact_type: 'person', name: 'Child',
        parent_id: 'p1', parent: null,
      }];
      powerSyncService.watch.returns(of(mockRows));

      service.watchByParent('p1').subscribe({
        next: (docs) => {
          expect(docs.length).to.equal(1);
          expect(docs[0]._id).to.equal('c1');

          // Verify correct SQL was passed
          const [sql, params] = powerSyncService.watch.firstCall.args;
          expect(sql).to.include('parent_id = ?');
          expect(params).to.deep.equal(['p1']);
          done();
        },
      });
    });

    it('should include type filter in SQL when provided', (done) => {
      powerSyncService.watch.returns(of([]));

      service.watchByParent('p1', 'clinic').subscribe({
        next: () => {
          const [sql, params] = powerSyncService.watch.firstCall.args;
          expect(sql).to.include('contact_type = ?');
          expect(params).to.deep.equal(['p1', 'clinic']);
          done();
        },
      });
    });
  });

  describe('toDocument (via get)', () => {
    it('should handle contact with geolocation', async () => {
      powerSyncService.getContactsByType.resolves([{
        id: 'c1',
        type: 'contact',
        contact_type: 'person',
        name: 'Geo Person',
        geolocation: '{"latitude":1.5,"longitude":36.8}',
        parent_id: null,
        parent: null,
      }]);

      const result = await service.get(['person']);
      expect(result[0].geolocation).to.deep.equal({ latitude: 1.5, longitude: 36.8 });
    });

    it('should handle contact with muted state', async () => {
      powerSyncService.getContactsByType.resolves([{
        id: 'c1',
        type: 'contact',
        contact_type: 'person',
        name: 'Muted Person',
        muted: '2026-01-01T00:00:00Z',
        parent_id: null,
        parent: null,
      }]);

      const result = await service.get(['person']);
      expect(result[0].muted).to.equal('2026-01-01T00:00:00Z');
    });

    it('should handle contact with contact_id (primary contact for places)', async () => {
      powerSyncService.getContactsByType.resolves([{
        id: 'clinic-1',
        type: 'contact',
        contact_type: 'clinic',
        name: 'Test Clinic',
        contact_id: 'person-1',
        parent_id: null,
        parent: null,
      }]);

      const result = await service.get(['clinic']);
      expect(result[0].contact).to.deep.equal({ _id: 'person-1' });
    });

    it('should handle invalid parent JSON gracefully', async () => {
      powerSyncService.getContactsByType.resolves([{
        id: 'c1',
        type: 'contact',
        contact_type: 'person',
        name: 'Bad JSON',
        parent_id: 'p1',
        parent: 'not-valid-json{',
      }]);

      const result = await service.get(['person']);
      // Should fall back to parent_id
      expect(result[0].parent).to.deep.equal({ _id: 'p1' });
    });
  });
});
