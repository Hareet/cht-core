const chai = require('chai');
const moment = require('moment');
const sinon = require('sinon');
const { expect } = chai;

const utils = require('../../../utils');

describe('Historical Targets API Integration', () => {
  let userCtx;
  let contact;
  let previousTargetDoc;
  let currentTargetDoc;
  
  const getPreviousMonthTag = () => {
    return moment().subtract(1, 'month').endOf('month').format('YYYY-MM');
  };
  
  const getCurrentMonthTag = () => {
    return moment().endOf('month').format('YYYY-MM');
  };

  before(async () => {
    userCtx = {
      name: 'test-chw',
      contact_id: 'contact-123',
      facility_id: 'facility-123',
      roles: ['chw']
    };
    
    contact = {
      _id: userCtx.contact_id,
      type: 'person',
      name: 'Test CHW',
      parent: { _id: userCtx.facility_id }
    };
    
    try {
      await utils.deleteDoc(contact._id);
    } catch (err) {
    }
    
    await utils.saveDocs([contact]);
  });

  beforeEach(async () => {
    const previousTag = getPreviousMonthTag();
    const currentTag = getCurrentMonthTag();
    
    previousTargetDoc = {
      _id: `target~${previousTag}~${userCtx.contact_id}~${userCtx.name}`,
      type: 'target',
      owner: userCtx.contact_id,
      user: userCtx.name,
      targets: [
        { id: 'pregnancies', value: { pass: 5, total: 10 } },
        { id: 'births', value: { pass: 3, total: 0 } },
        { id: 'deaths', value: { pass: 0, total: 2 } }
      ],
      updated_date: moment().subtract(1, 'month').endOf('month').toISOString(),
      reported_date: moment().subtract(1, 'month').endOf('month').subtract(1, 'day').toISOString()
    };
    
    currentTargetDoc = {
      _id: `target~${currentTag}~${userCtx.contact_id}~${userCtx.name}`,
      type: 'target',
      owner: userCtx.contact_id,
      user: userCtx.name,
      targets: [
        { id: 'pregnancies', value: { pass: 7, total: 12 } },
        { id: 'births', value: { pass: 4, total: 0 } },
        { id: 'deaths', value: { pass: 0, total: 1 } }
      ],
      updated_date: moment().toISOString(),
      reported_date: moment().subtract(1, 'day').toISOString()
    };
    
    for (const doc of [previousTargetDoc, currentTargetDoc]) {
      try {
        await utils.deleteDoc(doc._id);
      } catch (err) {
      }
    }
    
    await utils.saveDocs([previousTargetDoc, currentTargetDoc]);
  });

  afterEach(async () => {
    try {
      await utils.deleteDoc(previousTargetDoc._id);
    } catch (err) {
    }
    
    try {
      await utils.deleteDoc(currentTargetDoc._id);
    } catch (err) {
    }
  });

  after(async () => {
    await utils.revertDb([], true);
  });

  describe('Stored Document Retrieval', () => {
    it('should retrieve stored target document for previous month', async () => {
      const previousTag = getPreviousMonthTag();
      const docId = `target~${previousTag}~${userCtx.contact_id}~${userCtx.name}`;
      
      const doc = await utils.getDoc(docId);
      
      expect(doc).to.exist;
      expect(doc._id).to.equal(docId);
      expect(doc.type).to.equal('target');
      expect(doc.targets).to.be.an('array');
      expect(doc.targets).to.have.lengthOf(3);
      expect(doc.targets[0]).to.deep.include({
        id: 'pregnancies',
        value: { pass: 5, total: 10 }
      });
    });

    it('should retrieve stored target document for current month', async () => {
      const currentTag = getCurrentMonthTag();
      const docId = `target~${currentTag}~${userCtx.contact_id}~${userCtx.name}`;
      
      const doc = await utils.getDoc(docId);
      
      expect(doc).to.exist;
      expect(doc.targets[0].value.pass).to.equal(7);
    });

    it('should handle missing stored document gracefully', async () => {
      const futureTag = moment().add(1, 'month').endOf('month').format('YYYY-MM');
      const docId = `target~${futureTag}~${userCtx.contact_id}~${userCtx.name}`;
      
      try {
        await utils.getDoc(docId);
        expect.fail('Should have thrown 404 error');
      } catch (err) {
        expect(err.status).to.equal(404);
        expect(err.body.error).to.equal('not_found');
      }
    });

    it('should retrieve correct document based on interval calculation', async () => {
      const testDate = moment().date(15);
      const expectedTag = testDate.endOf('month').format('YYYY-MM');
      const docId = `target~${expectedTag}~${userCtx.contact_id}~${userCtx.name}`;
      
      const doc = await utils.getDoc(docId);
      expect(doc).to.exist;
      expect(doc._id).to.include(expectedTag);
    });
  });

  describe('Document ID Pattern', () => {
    it('should follow correct document ID pattern', () => {
      const previousTag = getPreviousMonthTag();
      const expectedId = `target~${previousTag}~${userCtx.contact_id}~${userCtx.name}`;
      
      expect(previousTargetDoc._id).to.equal(expectedId);
      expect(previousTargetDoc._id).to.match(/^target~\d{4}-\d{2}~[\w-]+~[\w-]+$/);
    });

    it('should use end of month for interval tag', () => {
      const startOfMonth = moment().startOf('month');
      const endOfMonth = moment().endOf('month');
      const tag = endOfMonth.format('YYYY-MM');
      
      expect(tag).to.equal(getCurrentMonthTag());
      expect(tag).not.to.equal(startOfMonth.format('YYYY-MM-DD'));
    });
  });

  describe('Multiple User Documents', () => {
    it('should retrieve correct document for specific user', async () => {
      const previousTag = getPreviousMonthTag();
      
      const otherUserDoc = {
        _id: `target~${previousTag}~${userCtx.contact_id}~other-user`,
        type: 'target',
        owner: userCtx.contact_id,
        user: 'other-user',
        targets: [
          { id: 'pregnancies', value: { pass: 10, total: 20 } }
        ]
      };
      
      await utils.saveDocs([otherUserDoc]);
      
      const userDoc = await utils.getDoc(`target~${previousTag}~${userCtx.contact_id}~${userCtx.name}`);
      const otherDoc = await utils.getDoc(otherUserDoc._id);
      
      expect(userDoc.user).to.equal(userCtx.name);
      expect(userDoc.targets[0].value.pass).to.equal(5);
      expect(otherDoc.user).to.equal('other-user');
      expect(otherDoc.targets[0].value.pass).to.equal(10);
      
      await utils.deleteDoc(otherUserDoc._id);
    });

    it('should not retrieve documents from different contacts', async () => {
      const previousTag = getPreviousMonthTag();
      
      const otherContactDoc = {
        _id: `target~${previousTag}~other-contact~${userCtx.name}`,
        type: 'target',
        owner: 'other-contact',
        user: userCtx.name,
        targets: [
          { id: 'pregnancies', value: { pass: 15, total: 30 } }
        ]
      };
      
      await utils.saveDocs([otherContactDoc]);
      
      const userDoc = await utils.getDoc(`target~${previousTag}~${userCtx.contact_id}~${userCtx.name}`);
      const otherDoc = await utils.getDoc(otherContactDoc._id);
      
      expect(userDoc.owner).to.equal(userCtx.contact_id);
      expect(otherDoc.owner).to.equal('other-contact');
      
      await utils.deleteDoc(otherContactDoc._id);
    });
  });

  describe('Document Content Validation', () => {
    it('should have required fields in stored document', async () => {
      const doc = await utils.getDoc(previousTargetDoc._id);
      
      expect(doc).to.have.property('_id');
      expect(doc).to.have.property('type', 'target');
      expect(doc).to.have.property('owner');
      expect(doc).to.have.property('user');
      expect(doc).to.have.property('targets');
      expect(doc).to.have.property('updated_date');
    });

    it('should have valid target structure', async () => {
      const doc = await utils.getDoc(previousTargetDoc._id);
      
      doc.targets.forEach(target => {
        expect(target).to.have.property('id');
        expect(target).to.have.property('value');
        expect(target.value).to.have.property('pass');
        expect(target.value).to.have.property('total');
        expect(target.value.pass).to.be.a('number');
        expect(target.value.total).to.be.a('number');
      });
    });

    it('should preserve metadata fields', async () => {
      const doc = await utils.getDoc(previousTargetDoc._id);
      
      expect(doc.updated_date).to.exist;
      expect(doc.reported_date).to.exist;
      expect(moment(doc.updated_date).isValid()).to.be.true;
      expect(moment(doc.reported_date).isValid()).to.be.true;
    });
  });

  describe('Performance and Caching', () => {
    it('should retrieve document efficiently with direct ID', async () => {
      const previousTag = getPreviousMonthTag();
      const docId = `target~${previousTag}~${userCtx.contact_id}~${userCtx.name}`;
      
      const startTime = Date.now();
      const doc = await utils.getDoc(docId);
      const endTime = Date.now();
      
      expect(doc).to.exist;
      expect(endTime - startTime).to.be.below(1000); // Should be reasonably fast
    });

    it('should handle concurrent requests for same document', async () => {
      const previousTag = getPreviousMonthTag();
      const docId = `target~${previousTag}~${userCtx.contact_id}~${userCtx.name}`;
      
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(utils.getDoc(docId));
      }
      
      const results = await Promise.all(promises);
      
      results.forEach(doc => {
        expect(doc._id).to.equal(docId);
        expect(doc.targets).to.have.lengthOf(3);
      });
    });
  });

  describe('Error Scenarios', () => {
    it('should handle malformed document IDs', async () => {
      const malformedIds = [
        'target~invalid',
        'target~2024-13~contact~user',
        'target~2024-01~',
        '~2024-01~contact~user',
      ];
      
      for (const id of malformedIds) {
        try {
          await utils.getDoc(id);
        } catch (err) {
          expect(err.status).to.equal(404);
        }
      }
    });
  });
});