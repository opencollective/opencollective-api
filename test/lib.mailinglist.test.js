import { expect } from 'chai';
import MailingList from '../server/lib/mailinglist.js';
import nock from 'nock';
import './mocks/mailgun.mailinglists.nock.js';

const debug = require('debug')('mailinglist');

const users = [
  {
    name: 'Xavier Damman',
    email: 'xdamman@gmail.com',
    tier: 'member'
  },
  {
    name: 'Aseem Sood',
    email: 'asood123@gmail.com',
    tier: 'backer'
  },
  {
    name: 'Pia Mancini',
    email: 'pia@opencollective.com',
    tier: 'backer'
  },
  {
    name: 'github',
    email: 'github@opencollective.com',
    tier: 'sponsor'
  }
]

const group = {
  slug: 'testcollective',
  name: 'Test Collective',
  settings: {},
  users: users
}

// nock.recorder.rec();

describe("mailing list", () => {

  const ml = new MailingList(group);

  before(() => {

  });

  after(() => {
    nock.cleanAll();
  });

  it("creates a new mailing list backers@testcollective.opencollective.com", (done) => {
    ml.createList('backers')
    .then(res => {
      expect(res.message).to.equal('Mailing list has been created');
      ml.destroyList('backers')
        .then(res => {
          expect(res.message).to.equal('Mailing list has been removed');
          done();
        })
    })
    .catch(done);
  })

  it("creates a new mailing list if doesn't exist yet and add the member", (done) => {
    ml.addMember(users[1], 'backers')
      .then(res => {
        debug("addmember res", res);
        expect(ml.lists).to.have.property('backers');
        expect(res.message).to.equal('Mailing list member has been created');
        expect(res.list.members_count).to.equal(1);
        ml.destroyList('backers').then(() => done()).catch(done);
      })
      .catch(done);
  });

  it("syncs a collective", (done) => {
    ml.syncCollective()
      .then(res => {
        expect(ml.lists.members).to.exist;
        expect(ml.lists.backers).to.exist;
        expect(ml.lists.sponsors).to.exist;
        expect(ml.lists.backers.members_count).to.equal(2);
        ml.destroyAllLists().then(() => {
          done();
        });
      })
      .catch(done);
  });
});