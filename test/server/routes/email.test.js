import Promise from 'bluebird';
import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import { createSandbox } from 'sinon';
import request from 'supertest';

import app from '../../../server/index';
import emailLib from '../../../server/lib/email';
import { md5 } from '../../../server/lib/utils';
import models from '../../../server/models';
import webhookBodyPayload from '../../mocks/mailgun.webhook.payload';
import initNock from '../../nocks/email.routes.test.nock.js';
import { randEmail } from '../../stores';
import { fakeCollective, fakeUser } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const generateToken = (email, slug, template) => {
  const uid = `${email}.${slug}.${template}.${config.keys.opencollective.jwtSecret}`;
  return md5(uid);
};

const fakeIntervalUser = () => {
  return fakeUser({ email: randEmail('test@opencollective.com') });
};

const { Collective } = models;

const usersData = [
  {
    firstName: 'Xavier',
    lastName: 'Damman',
    email: 'xdamman+test@gmail.com',
    role: 'ADMIN',
    image: 'https://pbs.twimg.com/profile_images/3075727251/5c825534ad62223ae6a539f6a5076d3c.jpeg',
  },
  {
    firstName: 'Aseem',
    lastName: 'Sood',
    email: randEmail('test@opencollective.com'),
    role: 'ADMIN',
  },
  {
    firstName: 'Pia',
    lastName: 'Mancini',
    email: randEmail('test@opencollective.com'),
    role: 'BACKER',
  },
  {
    firstName: 'github',
    lastName: '',
    email: 'github+test@opencollective.com',
    image: 'https://assets-cdn.github.com/images/modules/logos_page/GitHub-Logo.png',
    role: 'BACKER',
  },
];

const collectiveData = {
  slug: 'testcollective',
  name: 'Test Collective',
  settings: {},
};

let collective,
  users = [];

describe('server/routes/email', () => {
  let sandbox, expressApp;

  before(async () => {
    expressApp = await app();
  });

  before(() => utils.resetTestDB());

  before(initNock);

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  after(() => {
    nock.cleanAll();
  });

  before('create collective and members', async () => {
    collective = await Collective.create(collectiveData);

    users = await Promise.map(usersData, u => models.User.createUserWithCollective(u));

    await Promise.map(users, (user, index) => collective.addUserWithRole(user, usersData[index].role));

    await Promise.map(users, (user, index) => {
      const lists = usersData[index].lists || [];
      return Promise.map(lists, list =>
        models.Notification.create({
          channel: 'email',
          UserId: user.id,
          CollectiveId: collective.id,
          type: list,
        }),
      );
    });
  });

  it('forwards emails sent to info@:slug.opencollective.com if enabled', async () => {
    const spy = sandbox.spy(emailLib, 'sendMessage');
    const collective = await fakeCollective({ settings: { features: { forwardEmails: true } } });
    const users = await Promise.all([fakeIntervalUser(), fakeIntervalUser(), fakeIntervalUser()]);
    await Promise.all(users.map(user => collective.addUserWithRole(user, 'ADMIN')));

    return request(expressApp)
      .post('/webhooks/mailgun')
      .send(
        Object.assign({}, webhookBodyPayload, {
          recipient: `info@${collective.slug}.opencollective.com`,
        }),
      )
      .then(res => {
        expect(res.statusCode).to.equal(200);
        expect(spy.lastCall.args[0]).to.equal(`info@${collective.slug}.opencollective.com`);
        expect(spy.lastCall.args[1]).to.equal(webhookBodyPayload.subject);
        expect(users.map(u => u.email).indexOf(spy.lastCall.args[3].bcc) !== -1).to.be.true;
      });
  });

  it('do not forwards emails sent to info@:slug.opencollective.com', async () => {
    const spy = sandbox.spy(emailLib, 'sendMessage');
    const collective = await fakeCollective();
    const user = await fakeIntervalUser();
    await collective.addUserWithRole(user, 'ADMIN');
    const endpoint = request(expressApp).post('/webhooks/mailgun');
    const res = await endpoint.send(
      Object.assign({}, webhookBodyPayload, {
        recipient: `info@${collective.slug}.opencollective.com`,
      }),
    );

    expect(res.body.error).to.exist;
    expect(spy.lastCall).to.not.exist;
  });

  it('rejects emails sent to unknown mailing list', () => {
    const unknownMailingListWebhook = Object.assign({}, webhookBodyPayload, {
      recipient: 'unknown@testcollective.opencollective.com',
    });

    return request(expressApp)
      .post('/webhooks/mailgun')
      .send(unknownMailingListWebhook)
      .then(res => {
        expect(res.statusCode).to.equal(200);
        expect(res.body.error.message).to.equal(
          'Invalid mailing list address unknown@testcollective.opencollective.com',
        );
      });
  });

  describe('unsubscribe', () => {
    const template = 'mailinglist.admins';

    const generateUnsubscribeUrl = email => {
      const token = generateToken(email, collectiveData.slug, template);
      return `/services/email/unsubscribe/${encodeURIComponent(email)}/${collectiveData.slug}/${template}/${token}`;
    };

    it('returns an error if invalid token', () => {
      return request(expressApp)
        .get(
          `/services/email/unsubscribe/${encodeURIComponent(usersData[0].email)}/${
            collectiveData.slug
          }/${template}/xxxxxxxxxx`,
        )
        .then(res => {
          expect(res.statusCode).to.equal(400);
          expect(res.body.error.message).to.equal('Invalid token');
        });
    });

    it('unsubscribes', () => {
      const where = {
        UserId: users[0].id,
        CollectiveId: collective.id,
        type: 'mailinglist.admins',
        active: true,
      };

      return request(expressApp)
        .get(generateUnsubscribeUrl(users[0].email))
        .then(() => models.Notification.count({ where }))
        .then(count => expect(count).to.equal(0));
    });
  });
});
