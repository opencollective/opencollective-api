import { expect } from 'chai';
import moment from 'moment';

import models from '../../../server/models';
import { LEGAL_DOCUMENT_REQUEST_STATUS } from '../../../server/models/LegalDocument';
import * as utils from '../../utils';

const { LegalDocument, User, Collective } = models;

describe('server/models/LegalDocument', () => {
  // globals to be set in the before hooks.
  let hostCollective, user, userCollective;

  const documentData = {
    year: moment().year(),
  };

  const userData = {
    username: 'xdamman',
    email: 'xdamman@opencollective.com',
  };

  const hostCollectiveData = {
    slug: 'myhost',
    name: 'myhost',
    currency: 'USD',
    tags: ['#brusselstogether'],
    tiers: [
      {
        name: 'backer',
        range: [2, 100],
        interval: 'monthly',
      },
      {
        name: 'sponsor',
        range: [100, 100000],
        interval: 'yearly',
      },
    ],
  };

  beforeEach(async () => await utils.resetTestDB());
  beforeEach(async () => {
    hostCollective = await Collective.create(hostCollectiveData);
    user = await User.createUserWithCollective(userData);
    userCollective = await Collective.findByPk(user.CollectiveId);
  });

  it('it can set and save a new document_link', async () => {
    const expected = 'a string';
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);

    doc.documentLink = expected;
    await doc.save();
    await doc.reload();

    expect(doc.documentLink).to.eq(expected);
  });

  // I think this is the correct behaviour. We have to keep tax records for 7 years. Maybe this clashes with GDPR? For now it's only on the Open Source Collective which is US based. So I _think_ it's ok.
  // This assumes collectives will never be force deleted. If they are then the Legal Document model will fail its foreign key constraint when you try and load it.
  it('it will not be deleted if the user collective is soft deleted', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);
    expect(doc.deletedAt).to.eq(null);

    await userCollective.destroy();

    // This would fail if the doc was deleted
    expect(doc.reload()).to.be.fulfilled;
  });

  it('it can be deleted without deleting the collectives it belongs to', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);
    // Normally docs are soft deleted. This is just checking that worst case we don't accidentally delete collectives.
    await doc.destroy({ force: true });

    await userCollective.reload();

    expect(hostCollective.id).to.not.eq(null);
    expect(userCollective.id).to.not.eq(null);
  });

  it('can set and save a valid new request status', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);

    expect(doc.requestStatus).to.eq(LEGAL_DOCUMENT_REQUEST_STATUS.NOT_REQUESTED);

    doc.requestStatus = LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED;
    await doc.save();
    await doc.reload();

    expect(doc.requestStatus).to.eq(LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED);
  });

  it('it will fail if attempting to set an invalid request status', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);

    expect(doc.requestStatus).to.eq(LEGAL_DOCUMENT_REQUEST_STATUS.NOT_REQUESTED);

    doc.requestStatus = 'SCUTTLEBUTT';
    expect(doc.save()).to.be.rejected;
  });

  it('it can be found via its collective', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);

    const retrievedDocs = await userCollective.getLegalDocuments();

    expect(retrievedDocs[0].id).to.eq(doc.id);
  });

  it('it can get its associated collective', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);

    const retrievedCollective = await doc.getCollective();

    expect(retrievedCollective.id).to.eq(userCollective.id);
  });

  it("it can't be created if the year is less than 2015", async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    legalDoc.year = 2014;
    expect(LegalDocument.create(legalDoc)).to.be.rejected;
  });

  it("it can't be created if the year is null", async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    delete legalDoc.year;
    expect(LegalDocument.create(legalDoc)).to.be.rejected;
  });

  it('it enforces the composite unique constraint over year, CollectiveId and documentType', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    await LegalDocument.create(legalDoc);
    expect(LegalDocument.create(legalDoc)).to.be.rejected;

    const user2 = await User.createUserWithCollective({ username: 'piet', email: 'piet@opencollective.com' });
    const user2Collective = await Collective.findByPk(user2.CollectiveId);

    const legalDoc2 = Object.assign({}, documentData, {
      CollectiveId: user2Collective.id,
    });
    expect(LegalDocument.create(legalDoc2)).to.be.fulfilled;

    const legalDoc3 = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
      year: 5000, // this test will fail in the year 5000.
    });
    expect(LegalDocument.create(legalDoc3)).to.be.fulfilled;

    // Ideally we'd test with a different documentType too but there's only one at the moment.
  });

  it("it can't be created if the CollectiveId is null", async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: null,
    });
    expect(LegalDocument.create(legalDoc)).to.be.rejected;
  });

  it('can be created and has expected values', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);
    expect(doc.requestStatus).to.eq(LEGAL_DOCUMENT_REQUEST_STATUS.NOT_REQUESTED);
  });
});
