import { expect } from 'chai';
import config from 'config';

import { CollectiveType } from '../../../server/graphql/v1/CollectiveInterface';
import { searchCollectivesByEmail, searchCollectivesInDB } from '../../../server/lib/search';
import { newUser } from '../../stores';
import { fakeCollective, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/search', () => {
  before(resetTestDB);

  describe('Search in DB', () => {
    it('By slug', async () => {
      const { userCollective } = await newUser();
      const [results] = await searchCollectivesInDB(userCollective.slug);
      expect(results.find(collective => collective.id === userCollective.id)).to.exist;
    });

    it('By slug (prefixed with an @)', async () => {
      const { userCollective } = await newUser();
      const [results] = await searchCollectivesInDB(`@${userCollective.slug}`);
      expect(results.find(collective => collective.id === userCollective.id)).to.exist;
    });

    it('By name', async () => {
      const name = 'AVeryUniqueName ThatNoOneElseHas';
      const { userCollective } = await newUser(name);
      const [results] = await searchCollectivesInDB(name);
      expect(results.find(collective => collective.id === userCollective.id)).to.exist;
    });

    it('By tag', async () => {
      const tags = ['open source', 'stuff', 'potatoes'];
      const collective = await fakeCollective({ tags });
      const [results] = await searchCollectivesInDB('potatoes');
      expect(results.find(c => c.id === collective.id)).to.exist;
    });

    it("Doesn't return items with the wrong type", async () => {
      const typeFilter = [CollectiveType.ORGANIZATION];
      const { userCollective } = await newUser();
      const [results, count] = await searchCollectivesInDB(userCollective.slug, 0, 10000, { types: typeFilter });
      expect(results.length).to.eq(0);
      expect(count).to.eq(0);
    });

    it('Does not break if submitting strange input', async () => {
      const description = 'Wow thats&&}{\'" !%|wow AVeryUniqueDescriptionZZZzzz I swear!!!';
      const tags = ['\'"{}[]!&|dsa🔥️das'];
      const collective = await fakeCollective({ description, tags });
      const [results] = await searchCollectivesInDB('!%|wow🔥️🔥️ AVeryUniqueDescriptionZZZzzz!! &&}{\'"');
      expect(results.find(c => c.id === collective.id)).to.exist;
    });

    it('Works with punctuation', async () => {
      const name = "The Watchers' defense Collective";
      const collective = await fakeCollective({ name });
      const [results] = await searchCollectivesInDB("Watcher's defense");
      expect(results.find(res => res.id === collective.id)).to.exist;
    });

    describe('By email', async () => {
      it('returns exact match', async () => {
        const user = await fakeUser();
        const searchedUser = await fakeUser();
        const [collectives] = await searchCollectivesByEmail(searchedUser.email, user);
        expect(collectives[0].id).to.equal(searchedUser.CollectiveId);
      });

      it('is rate limited', async () => {
        const user = await fakeUser();
        const searchedUser = await fakeUser();
        for (let i = 0; i < config.limits.searchEmailPerHour; i++) {
          await searchCollectivesByEmail(searchedUser.email, user);
        }

        const searchPromise = searchCollectivesByEmail(searchedUser.email, user);
        await expect(searchPromise).to.be.eventually.rejectedWith('Rate limit exceeded');
      });
    });
  });

  describe('Search by email', async () => {
    it('Returns the user profile', async () => {
      const { user, userCollective } = await newUser();
      const [results, count] = await searchCollectivesByEmail(user.email, user);
      expect(count).to.eq(1);
      expect(results.find(collective => collective.id === userCollective.id)).to.exist;
    });
  });
});
