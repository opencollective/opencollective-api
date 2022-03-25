import { expect } from 'chai';
import config from 'config';

import { CollectiveType } from '../../../server/graphql/v1/CollectiveInterface';
import {
  buildSearchConditions,
  parseSearchTerm,
  searchCollectivesByEmail,
  searchCollectivesInDB,
} from '../../../server/lib/search';
import { Op } from '../../../server/models';
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

  describe('parseSearchTerm', () => {
    it('detects IDs', () => {
      expect(parseSearchTerm('#123')).to.deep.equal({ type: 'id', term: 123 });
    });

    it('detects slugs', () => {
      expect(parseSearchTerm('@test')).to.deep.equal({ type: 'slug', term: 'test' });
      expect(parseSearchTerm('@test-hyphen')).to.deep.equal({ type: 'slug', term: 'test-hyphen' });
    });

    it('detects numbers', () => {
      expect(parseSearchTerm('42')).to.deep.equal({ type: 'number', term: 42, isFloat: false });
      expect(parseSearchTerm('42.')).to.deep.equal({ type: 'number', term: 42, isFloat: true });
      expect(parseSearchTerm('42.64')).to.deep.equal({ type: 'number', term: 42.64, isFloat: true });
    });

    it('goes back to text for everything else', () => {
      expect(parseSearchTerm('')).to.deep.equal({ type: 'text', term: '' });
      expect(parseSearchTerm('test')).to.deep.equal({ type: 'text', term: 'test' });
      expect(parseSearchTerm('test-hyphen')).to.deep.equal({ type: 'text', term: 'test-hyphen' });
      expect(parseSearchTerm('#4242 not an id')).to.deep.equal({ type: 'text', term: '#4242 not an id' });
      expect(parseSearchTerm('@slug not a slug')).to.deep.equal({ type: 'text', term: '@slug not a slug' });
    });
  });

  describe('buildSearchConditions', () => {
    const TEST_FIELDS_CONFIGURATION = {
      slugFields: ['slug', '$fromCollective.slug$'],
      idFields: ['id', '$fromCollective.id$'],
      textFields: ['name', '$fromCollective.name$'],
      amountFields: ['amount', '$order.totalAmount$'],
      stringArrayFields: ['tags'],
    };

    const testBuildSearchConditionsWithCustomConfig = (searchTerm, fieldsConfig, options) => {
      const conditions = buildSearchConditions(searchTerm, fieldsConfig, options);
      conditions.forEach(condition => {
        Object.keys(condition).forEach(field => {
          // We must operators like the ILIKE operator, as toString/expect is not parsing these flag
          if (condition[field][Op.iLike]) {
            condition[field]['ILIKE'] = condition[field][Op.iLike];
          }
          if (condition[field][Op.overlap]) {
            condition[field]['OVERLAP'] = condition[field][Op.overlap];
          }
        });
      });

      return conditions;
    };

    const testBuildSearchConditions = (searchTerm, expectedResults) => {
      return testBuildSearchConditionsWithCustomConfig(
        searchTerm,
        TEST_FIELDS_CONFIGURATION,
        undefined,
        expectedResults,
      );
    };

    it('returns no condition for an empty search', () => {
      expect(testBuildSearchConditions('')).to.deep.eq([]);
    });

    it('build conditions for IDs', () => {
      expect(testBuildSearchConditions('#4242')).to.deep.eq([{ id: 4242 }, { '$fromCollective.id$': 4242 }]);
    });

    it('build conditions for slugs', () => {
      expect(testBuildSearchConditions('@betree')).to.deep.eq([
        { slug: 'betree' },
        { '$fromCollective.slug$': 'betree' },
      ]);
    });

    it('build conditions for numbers', () => {
      expect(testBuildSearchConditions('4242')).to.deep.eq([
        { slug: { ILIKE: '%4242%' } },
        { '$fromCollective.slug$': { ILIKE: '%4242%' } },
        { name: { ILIKE: '%4242%' } },
        { '$fromCollective.name$': { ILIKE: '%4242%' } },
        { tags: { OVERLAP: ['4242'] } },
        { id: 4242 },
        { '$fromCollective.id$': 4242 },
        { amount: 424200 },
        { '$order.totalAmount$': 424200 },
      ]);

      expect(testBuildSearchConditions('4242.66')).to.deep.eq([
        { slug: { ILIKE: '%4242.66%' } },
        { '$fromCollective.slug$': { ILIKE: '%4242.66%' } },
        { name: { ILIKE: '%4242.66%' } },
        { '$fromCollective.name$': { ILIKE: '%4242.66%' } },
        { tags: { OVERLAP: ['4242.66'] } },
        { amount: 424266 },
        { '$order.totalAmount$': 424266 },
      ]);
    });

    it('build conditions for full text', () => {
      expect(testBuildSearchConditions('   hello world   ')).to.deep.eq([
        { slug: { ILIKE: '%hello world%' } },
        { '$fromCollective.slug$': { ILIKE: '%hello world%' } },
        { name: { ILIKE: '%hello world%' } },
        { '$fromCollective.name$': { ILIKE: '%hello world%' } },
        { tags: { OVERLAP: ['hello world'] } },
      ]);
    });

    it('can transform text for string arrays', () => {
      const fieldsConfig = { stringArrayFields: ['tags'] };

      // No transform: will only trim
      expect(testBuildSearchConditionsWithCustomConfig('   hello   WorlD   ', fieldsConfig)).to.deep.eq([
        { tags: { OVERLAP: ['hello WorlD'] } },
      ]);

      // Uppercase
      const options = { stringArrayTransformFn: value => value.toUpperCase() };
      expect(testBuildSearchConditionsWithCustomConfig('   hello   WorlD   ', fieldsConfig, options)).to.deep.eq([
        { tags: { OVERLAP: ['HELLO WORLD'] } },
      ]);
    });
  });
});
