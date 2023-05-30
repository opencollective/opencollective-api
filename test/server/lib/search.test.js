import { expect } from 'chai';
import config from 'config';
import { times } from 'lodash';

import { CollectiveType } from '../../../server/graphql/v1/CollectiveInterface';
import {
  buildSearchConditions,
  parseSearchTerm,
  searchCollectivesByEmail,
  searchCollectivesInDB,
} from '../../../server/lib/search';
import { Op } from '../../../server/models';
import { newUser } from '../../stores';
import { fakeCollective, fakeHost, fakeUser, randStr } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/search', () => {
  before(async () => {
    await resetTestDB();
  });

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

    describe('By name', () => {
      it('matches with the exact search term', async () => {
        const name = 'AVeryUniqueName ThatNoOneElseHas';
        const { userCollective } = await newUser(name);
        const [results] = await searchCollectivesInDB(name);
        expect(results.find(collective => collective.id === userCollective.id)).to.exist;
      });

      it('matches when spaces are included in search term and not in name', async () => {
        const name = 'SomethingNew';
        const { userCollective } = await newUser(name);
        const [results] = await searchCollectivesInDB('Something New');
        expect(results.find(collective => collective.id === userCollective.id)).to.exist;
      });

      it('does not match when spaces are not included in search term and are in name', async () => {
        const name = 'Something New';
        const { userCollective } = await newUser(name);
        const [results] = await searchCollectivesInDB('SomethingNew');
        expect(results.find(collective => collective.id === userCollective.id)).to.not.exist;
      });
    });

    describe('By tag', () => {
      it('works with the basics', async () => {
        const tags = ['open source', 'stuff', 'potatoes'];
        const collective = await fakeCollective({ tags });
        const [results] = await searchCollectivesInDB('potatoes');
        expect(results.find(c => c.id === collective.id)).to.exist;
      });

      it('does not break with special characters', async () => {
        await fakeCollective({ tags: ['something with "double" quotes'] });
        await fakeCollective({ tags: ["something with 'simple' quotes"] });

        const [results1] = await searchCollectivesInDB('"double');
        expect(results1).to.have.length(1);
        expect(results1[0].tags).to.include('something with "double" quotes');

        const [results2] = await searchCollectivesInDB("'simple");
        expect(results2).to.have.length(1);
        expect(results2[0].tags).to.include("something with 'simple' quotes");
      });
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

    describe('Works with punctuation', async () => {
      it('with an apostrophe', async () => {
        const name = "The Watchers' defense Collective";
        const collective = await fakeCollective({ name });
        const [results] = await searchCollectivesInDB("Watcher's defense");
        expect(results.find(res => res.id === collective.id)).to.exist;
      });

      it('with a comma', async () => {
        const name = 'Ethics, Public Policy, and Technological Change Course';
        const collective = await fakeCollective({ name });
        const [results] = await searchCollectivesInDB('Ethics, Public Policy, and Technological Change Course');
        expect(results.length).to.eq(1);
        expect(results.find(res => res.id === collective.id)).to.exist;
      });
    });

    it('supports OR operator', async () => {
      const accounts = await Promise.all(times(3, () => fakeCollective({ name: randStr() })));
      const accountNames = accounts.map(c => c.name);
      const [results] = await searchCollectivesInDB(accountNames.join(' OR '));
      expect(results.length).to.eq(3);
      expect(results.map(c => c.name)).to.deep.eqInAnyOrder(accountNames);
    });

    it('supports quotes for exact search', async () => {
      const accountWithExactMatch = await fakeCollective({ description: 'The description must match exactly' });
      await fakeCollective({ description: 'Exactly must the description match' }); // Should not match
      const [results] = await searchCollectivesInDB('"The description must match exactly"');
      expect(results.length).to.eq(1);
      expect(results[0].id).to.eq(accountWithExactMatch.id);
    });

    it('supports empty search', async () => {
      const [results] = await searchCollectivesInDB('');
      expect(results.length).to.be.above(1);

      const [results2] = await searchCollectivesInDB('   ');
      expect(results2.length).to.be.above(1);
    });

    it('empty quotes', async () => {
      // act as empty search
      const [results] = await searchCollectivesInDB('""');
      expect(results.length).to.be.above(1);

      // we have no account with multiple spaces in their searchable content
      const [results2] = await searchCollectivesInDB('"  "');
      expect(results2.length).to.eq(0);
    });

    describe('ignores diacritics', () => {
      let accountWithDiacritics;

      before(async () => {
        accountWithDiacritics = await fakeCollective({ name: 'Árvíztűrő tükörfúrógép' });
      });

      it('when searching for a phrase with diacritics in the search input', async () => {
        const [results2] = await searchCollectivesInDB('árvíztűrő tükörfúrógép');
        expect(results2.length).to.eq(1);
        expect(results2[0].id).to.eq(accountWithDiacritics.id);
      });

      it('when searching with a country filter give correct results', async () => {
        const collectiveName = 'JHipster Canada';
        const collective = await fakeCollective({ name: collectiveName, countryISO: 'CA' });
        const [results] = await searchCollectivesInDB('JHipster', undefined, undefined, { countries: ['CA'] });
        expect(results.length).to.eq(1);
        expect(results.find(res => res.id === collective.id)).to.exist;
      });

      it('return child collectives whose parents country match the given country filter', async () => {
        const collectiveName = 'JHipster';
        const childCollective = 'JHipsterLite Project';
        const collective = await fakeCollective({ name: collectiveName, countryISO: 'LK' });
        const project = await fakeCollective({ name: childCollective, ParentCollectiveId: collective.id });
        const [results] = await searchCollectivesInDB('', undefined, undefined, { countries: ['LK'] });
        expect(results.length).to.eq(2);
        expect(results.find(res => res.id === collective.id)).to.exist;
        expect(results.find(res => res.id === project.id)).to.exist;
      });

      // TODO: We want the 3 cases below to be supported, but it probably requires removing the diacritics when building Collectives.searchTsVector

      // it('when searching for a phrase without diacritics in the search input', async () => {
      //   const [results2] = await searchCollectivesInDB('arvizturo tukorfurogep');
      //   expect(results2.length).to.eq(1);
      //   expect(results2[0].id).to.eq(accountWithDiacritics.id);
      // });

      // it('when searching for a single word without diacritics in the search input', async () => {
      //   const [results] = await searchCollectivesInDB('arvizturo');
      //   expect(results.length).to.eq(1);
      //   expect(results[0].id).to.eq(accountWithDiacritics.id);
      // });

      // it('when searching for a single word with diacritics in the search input', async () => {
      //   const [results] = await searchCollectivesInDB('árvíztűrő');
      //   expect(results.length).to.eq(1);
      //   expect(results[0].id).to.eq(accountWithDiacritics.id);
      // });
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

    describe('Hosts', async () => {
      beforeEach(async () => {
        await resetTestDB();
      });
      it('returns exact match', async () => {
        const host = await fakeHost({
          name: 'New Host',
        });
        const [collectives] = await searchCollectivesInDB('New Host', 0, 10, {
          isHost: true,
        });
        expect(collectives[0].id).to.equal(host.id);
      });

      it('Returns all hosts', async () => {
        await fakeHost({
          name: 'New Host 1',
        });
        await fakeHost({
          name: 'New Host 2',
        });
        const [collectives] = await searchCollectivesInDB('', 0, 10, {
          isHost: true,
        });
        expect(collectives).to.have.length(2);
      });

      it('Returns only hosts with open applications', async () => {
        await fakeHost({
          name: 'New Host 1',
        });
        const openHost = await fakeHost({
          name: 'New Host 2',
          settings: {
            apply: true,
          },
        });
        const [collectives] = await searchCollectivesInDB('', 0, 10, {
          isHost: true,
          onlyOpenHosts: true,
        });
        expect(collectives).to.have.length(1);
        expect(collectives[0].id).to.equal(openHost.id);
      });

      it('Orders by host flags and hosted collectives count', async () => {
        const zeroCollectives = await fakeHost({
          name: 'New Host 1',
        });
        const threeCollectives = await fakeHost({
          name: 'New Host 2',
        });
        await fakeCollective({ HostCollectiveId: threeCollectives.id });
        await fakeCollective({ HostCollectiveId: threeCollectives.id });
        await fakeCollective({ HostCollectiveId: threeCollectives.id });

        const oneCollective = await fakeHost({
          name: 'New Host 3',
        });

        await fakeCollective({ HostCollectiveId: oneCollective.id });

        const firstPartyHost = await fakeHost({
          name: 'First party Host',
          data: {
            isFirstPartyHost: true,
          },
        });

        const trustedHost = await fakeHost({
          name: 'Trusted Host',
          data: {
            isTrustedHost: true,
          },
        });

        const [collectives] = await searchCollectivesInDB('', 0, 10, {
          isHost: true,
          orderBy: { field: 'HOST_RANK', direction: 'DESC' },
        });
        expect(collectives).to.have.length(5);
        expect(collectives[0].id).to.equal(firstPartyHost.id);
        expect(collectives[1].id).to.equal(trustedHost.id);
        expect(collectives[2].id).to.equal(threeCollectives.id);
        expect(collectives[3].id).to.equal(oneCollective.id);
        expect(collectives[4].id).to.equal(zeroCollectives.id);
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
      return buildSearchConditions(searchTerm, fieldsConfig, options);
    };

    const testBuildSearchConditions = searchTerm => {
      return testBuildSearchConditionsWithCustomConfig(searchTerm, TEST_FIELDS_CONFIGURATION);
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
        { slug: { [Op.iLike]: '%4242%' } },
        { '$fromCollective.slug$': { [Op.iLike]: '%4242%' } },
        { name: { [Op.iLike]: '%4242%' } },
        { '$fromCollective.name$': { [Op.iLike]: '%4242%' } },
        { tags: { [Op.overlap]: ['4242'] } },
        { id: 4242 },
        { '$fromCollective.id$': 4242 },
        { amount: 424200 },
        { '$order.totalAmount$': 424200 },
      ]);

      expect(testBuildSearchConditions('4242.66')).to.deep.eq([
        { slug: { [Op.iLike]: '%4242.66%' } },
        { '$fromCollective.slug$': { [Op.iLike]: '%4242.66%' } },
        { name: { [Op.iLike]: '%4242.66%' } },
        { '$fromCollective.name$': { [Op.iLike]: '%4242.66%' } },
        { tags: { [Op.overlap]: ['4242.66'] } },
        { amount: 424266 },
        { '$order.totalAmount$': 424266 },
      ]);
    });

    it('build conditions for full text', () => {
      expect(testBuildSearchConditions('   hello world   ')).to.deep.eq([
        { slug: { [Op.iLike]: '%hello world%' } },
        { '$fromCollective.slug$': { [Op.iLike]: '%hello world%' } },
        { name: { [Op.iLike]: '%hello world%' } },
        { '$fromCollective.name$': { [Op.iLike]: '%hello world%' } },
        { tags: { [Op.overlap]: ['hello world'] } },
      ]);
    });

    it('can transform text for string arrays', () => {
      const fieldsConfig = { stringArrayFields: ['tags'] };

      // No transform: will only trim
      expect(testBuildSearchConditionsWithCustomConfig('   hello   WorlD   ', fieldsConfig)).to.deep.eq([
        { tags: { [Op.overlap]: ['hello WorlD'] } },
      ]);

      // Uppercase
      expect(
        testBuildSearchConditionsWithCustomConfig('   hello   WorlD   ', {
          ...fieldsConfig,
          stringArrayTransformFn: value => value.toUpperCase(),
        }),
      ).to.deep.eq([{ tags: { [Op.overlap]: ['HELLO WORLD'] } }]);
    });
  });
});
