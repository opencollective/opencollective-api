import { expect } from 'chai';
import config from 'config';

import { CollectiveType } from '../../../server/graphql/v1/CollectiveInterface';
import { searchCollectivesByEmail, searchCollectivesInDB } from '../../../server/lib/search';
import { newUser } from '../../stores';
import { fakeCollective, fakeUser } from '../../test-helpers/fake-data';

describe('server/lib/search', () => {
  describe('Search in DB', () => {
    it('By slug', async () => {
      const { userCollective } = await newUser();
      const [results] = await searchCollectivesInDB(userCollective.slug);
      expect(results.find(collective => collective.id === userCollective.id)).to.exist;
    });

    it('By name', async () => {
      const name = 'AVeryUniqueName ThatNoOneElseHas';
      const { userCollective } = await newUser(name);
      const [results] = await searchCollectivesInDB(name);
      expect(results.find(collective => collective.id === userCollective.id)).to.exist;
    });

    it('By long description', async () => {
      const longDescription = 'Wow thats AVeryUniqueDescription I swear!!!';
      const collective = await fakeCollective({ longDescription });
      const [results] = await searchCollectivesInDB('AVeryUniqueDescription');
      expect(results.find(c => c.id === collective.id)).to.exist;
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
      const [results, count] = await searchCollectivesInDB(userCollective.slug, 0, 10000, typeFilter);
      expect(results.length).to.eq(0);
      expect(count).to.eq(0);
    });

    it('Does not break if submitting strange input', async () => {
      const longDescription = 'Wow thats&&}{\'" !%|wow AVeryUniqueDescriptionZZZzzz I swear!!!';
      const tags = ['\'"{}[]!&|dsa🔥️das'];
      const collective = await fakeCollective({ longDescription, tags });
      const [results] = await searchCollectivesInDB('!%|wow🔥️🔥️ AVeryUniqueDescriptionZZZzzz!! &&}{\'"');
      expect(results.find(c => c.id === collective.id)).to.exist;
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
