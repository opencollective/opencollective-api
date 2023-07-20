import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import { createSandbox } from 'sinon';
import request from 'supertest';

import app from '../../../server/index.js';
import { md5 } from '../../../server/lib/utils.js';
import models from '../../../server/models/index.js';
import { randEmail } from '../../stores/index.js';
import * as utils from '../../utils.js';

const generateToken = (email, slug, template) => {
  const uid = `${email}.${slug}.${template}.${config.keys.opencollective.jwtSecret}`;
  return md5(uid);
};

const { Collective } = models;

const usersData = [
  {
    name: 'Xavier Damman',
    email: 'xdamman+test@gmail.com',
    role: 'ADMIN',
    image: 'https://pbs.twimg.com/profile_images/3075727251/5c825534ad62223ae6a539f6a5076d3c.jpeg',
  },
  {
    name: 'Aseem Sood',
    email: randEmail('test@opencollective.com'),
    role: 'ADMIN',
  },
  {
    name: 'Pia Mancini',
    email: randEmail('test@opencollective.com'),
    role: 'BACKER',
  },
  {
    name: 'github',
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

    users = await Promise.all(usersData.map(u => models.User.createUserWithCollective(u)));

    await Promise.all(users.map((user, index) => collective.addUserWithRole(user, usersData[index].role)));

    await Promise.all(
      users.map(async (user, index) => {
        const lists = usersData[index].lists || [];
        return await Promise.all(
          lists.map(list =>
            models.Notification.create({
              channel: 'email',
              UserId: user.id,
              CollectiveId: collective.id,
              type: list,
            }),
          ),
        );
      }),
    );
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
