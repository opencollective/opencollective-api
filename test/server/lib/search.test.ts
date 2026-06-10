import { expect } from 'chai';
import config from 'config';
import { sql } from 'kysely';
import { times } from 'lodash';

import { CollectiveType } from '../../../server/graphql/v1/CollectiveInterface';
import { getKysely } from '../../../server/lib/kysely';
import { EntityShortIdPrefix } from '../../../server/lib/permalink/entity-map';
import {
  buildKyselySearchConditions,
  buildSearchConditions,
  parseSearchTerm,
  sanitizeSearchTermForILike,
  searchCollectivesByEmail,
  searchCollectivesInDB,
} from '../../../server/lib/sql-search';
import { Op } from '../../../server/models';
import { newUser } from '../../stores';
import { fakeCollective, fakeHost, fakeUser, randStr } from '../../test-helpers/fake-data';
import { createPrivateAccountFixture } from '../../test-helpers/private-account-fixture';
import { makeRequest, resetTestDB } from '../../utils';

describe('server/lib/search', () => {
  const publicReq = makeRequest();

  before(async () => {
    await resetTestDB();
  });

  describe('Search in DB', () => {
    it('By slug', async () => {
      const { userCollective } = await newUser();
      const [results] = await searchCollectivesInDB(publicReq, userCollective.slug);
      expect(results.find(collective => collective.id === userCollective.id)).to.exist;
    });

    it('By slug (prefixed with an @)', async () => {
      const { userCollective } = await newUser();
      const [results] = await searchCollectivesInDB(publicReq, `@${userCollective.slug}`);
      expect(results.find(collective => collective.id === userCollective.id)).to.exist;
    });

    describe('By name', () => {
      it('matches with the exact search term', async () => {
        const name = 'AVeryUniqueName ThatNoOneElseHas';
        const { userCollective } = await newUser(name);
        const [results] = await searchCollectivesInDB(publicReq, name);
        expect(results.find(collective => collective.id === userCollective.id)).to.exist;
      });

      it('matches when spaces are included in search term and not in name', async () => {
        const name = 'SomethingNew';
        const { userCollective } = await newUser(name);
        const [results] = await searchCollectivesInDB(publicReq, 'Something New');
        expect(results.find(collective => collective.id === userCollective.id)).to.exist;
      });

      it('does not match when spaces are not included in search term and are in name', async () => {
        const name = 'Something New';
        const { userCollective } = await newUser(name);
        const [results] = await searchCollectivesInDB(publicReq, 'SomethingNew');
        expect(results.find(collective => collective.id === userCollective.id)).to.not.exist;
      });
    });

    describe('By tag', () => {
      it('works with the basics', async () => {
        const tags = ['open source', 'stuff', 'potatoes'];
        const collective = await fakeCollective({ tags });
        const [results] = await searchCollectivesInDB(publicReq, 'potatoes');
        expect(results.find(c => c.id === collective.id)).to.exist;
      });

      it('does not break with special characters', async () => {
        await fakeCollective({ tags: ['something with "double" quotes'] });
        await fakeCollective({ tags: ["something with 'simple' quotes"] });

        const [results1] = await searchCollectivesInDB(publicReq, '"double');
        expect(results1).to.have.length(1);
        expect(results1[0].tags).to.include('something with "double" quotes');

        const [results2] = await searchCollectivesInDB(publicReq, "'simple");
        expect(results2).to.have.length(1);
        expect(results2[0].tags).to.include("something with 'simple' quotes");
      });
    });

    it("Doesn't return items with the wrong type", async () => {
      const typeFilter = [CollectiveType['ORGANIZATION']];
      const { userCollective } = await newUser();
      const [results, count] = await searchCollectivesInDB(publicReq, userCollective.slug, 0, 10000, {
        types: typeFilter,
      });
      expect(results.length).to.eq(0);
      expect(count).to.eq(0);
    });

    it('Does not break if submitting strange input', async () => {
      const description = 'Wow thats&&}{\'" !%|wow AVeryUniqueDescriptionZZZzzz I swear!!!';
      const tags = ['\'"{}[]!&|dsa🔥️das'];
      const collective = await fakeCollective({ description, tags });
      const [results] = await searchCollectivesInDB(publicReq, '!%|wow🔥️🔥️ AVeryUniqueDescriptionZZZzzz!! &&}{\'"');
      expect(results.find(c => c.id === collective.id)).to.exist;
    });

    it('escapes ILIKE special characters (\\, %, _) to avoid "LIKE pattern must not end with escape character"', async () => {
      const [results] = await searchCollectivesInDB(publicReq, 'le 47 \\');
      expect(results).to.be.an('array');
      // No error should be thrown; the search completes successfully
    });

    describe('Works with punctuation', async () => {
      it('with an apostrophe', async () => {
        const name = "The Watchers' defense Collective";
        const collective = await fakeCollective({ name });
        const [results] = await searchCollectivesInDB(publicReq, "Watcher's defense");
        expect(results.find(res => res.id === collective.id)).to.exist;
      });

      it('with a comma', async () => {
        const name = 'Ethics, Public Policy, and Technological Change Course';
        const collective = await fakeCollective({ name });
        const [results] = await searchCollectivesInDB(
          publicReq,
          'Ethics, Public Policy, and Technological Change Course',
        );
        expect(results.length).to.eq(1);
        expect(results.find(res => res.id === collective.id)).to.exist;
      });
    });

    it('supports OR operator', async () => {
      const accounts = await Promise.all(times(3, () => fakeCollective({ name: randStr() })));
      const accountNames = accounts.map(c => c.name);
      const [results] = await searchCollectivesInDB(publicReq, accountNames.join(' OR '));
      expect(results.length).to.eq(3);
      expect(results.map(c => c.name)).to.deep.eqInAnyOrder(accountNames);
    });

    it('supports quotes for exact search', async () => {
      const accountWithExactMatch = await fakeCollective({ description: 'The description must match exactly' });
      await fakeCollective({ description: 'Exactly must the description match' }); // Should not match
      const [results] = await searchCollectivesInDB(publicReq, '"The description must match exactly"');
      expect(results.length).to.eq(1);
      expect(results[0].id).to.eq(accountWithExactMatch.id);
    });

    it('supports empty search', async () => {
      const [results] = await searchCollectivesInDB(publicReq, '');
      expect(results.length).to.be.above(1);

      const [results2] = await searchCollectivesInDB(publicReq, '   ');
      expect(results2.length).to.be.above(1);
    });

    it('empty quotes', async () => {
      // act as empty search
      const [results] = await searchCollectivesInDB(publicReq, '""');
      expect(results.length).to.be.above(1);

      // we have no account with multiple spaces in their searchable content
      const [results2] = await searchCollectivesInDB(publicReq, '"  "');
      expect(results2.length).to.eq(0);
    });

    describe('ignores diacritics', () => {
      let accountWithDiacritics;

      before(async () => {
        accountWithDiacritics = await fakeCollective({ name: 'Árvíztűrő tükörfúrógép' });
      });

      it('when searching for a phrase with diacritics in the search input', async () => {
        const [results2] = await searchCollectivesInDB(publicReq, 'árvíztűrő tükörfúrógép');
        expect(results2.length).to.eq(1);
        expect(results2[0].id).to.eq(accountWithDiacritics.id);
      });

      it('when searching with a country filter give correct results', async () => {
        const collectiveName = 'JHipster Canada';
        const collective = await fakeCollective({ name: collectiveName, countryISO: 'CA' });
        const [results] = await searchCollectivesInDB(publicReq, 'JHipster', undefined, undefined, {
          countries: ['CA'],
        });
        expect(results.length).to.eq(1);
        expect(results.find(res => res.id === collective.id)).to.exist;
      });

      it('return child collectives whose parents country match the given country filter', async () => {
        const collectiveName = 'JHipster';
        const childCollective = 'JHipsterLite Project';
        const collective = await fakeCollective({ name: collectiveName, countryISO: 'LK' });
        const project = await fakeCollective({ name: childCollective, ParentCollectiveId: collective.id });
        const [results] = await searchCollectivesInDB(publicReq, '', undefined, undefined, { countries: ['LK'] });
        expect(results.length).to.eq(2);
        expect(results.find(res => res.id === collective.id)).to.exist;
        expect(results.find(res => res.id === project.id)).to.exist;
      });

      // TODO: We want the 3 cases below to be supported, but it probably requires removing the diacritics when building Collectives.searchTsVector

      // it('when searching for a phrase without diacritics in the search input', async () => {
      //   const [results2] = await searchCollectivesInDB(publicReq, 'arvizturo tukorfurogep');
      //   expect(results2.length).to.eq(1);
      //   expect(results2[0].id).to.eq(accountWithDiacritics.id);
      // });

      // it('when searching for a single word without diacritics in the search input', async () => {
      //   const [results] = await searchCollectivesInDB(publicReq, 'arvizturo');
      //   expect(results.length).to.eq(1);
      //   expect(results[0].id).to.eq(accountWithDiacritics.id);
      // });

      // it('when searching for a single word with diacritics in the search input', async () => {
      //   const [results] = await searchCollectivesInDB(publicReq, 'árvíztűrő');
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
        for (let i = 0; i < config.limits.search.email.perHourPerUser; i++) {
          await searchCollectivesByEmail(searchedUser.email, user);
        }

        const searchPromise = searchCollectivesByEmail(searchedUser.email, user);
        await expect(searchPromise).to.be.eventually.rejectedWith('Rate limit exceeded');
      });
    });

    describe('Private collectives', () => {
      let fixture;

      before(async () => {
        fixture = await createPrivateAccountFixture();
        await fixture.privateCollective.update({ name: 'AVeryUniquePrivateCollectiveSearchName' });
        await fixture.privateHost.update({ name: 'AVeryUniquePrivateHostSearchName' });
        await fixture.privateProject.update({ name: 'AVeryUniquePrivateProjectSearchName' });
        await Promise.all(
          [fixture.randomUser, fixture.privateHostAdmin, fixture.privateCollectiveAdmin, fixture.rootAdmin].map(user =>
            user.populateRoles(),
          ),
        );
      });

      it('does not return private collectives to unauthenticated users', async () => {
        const [results] = await searchCollectivesInDB(publicReq, 'AVeryUniquePrivateCollectiveSearchName');
        expect(results.find(c => c.id === fixture.privateCollective.id)).to.not.exist;
      });

      it('does not return private collectives to unrelated users', async () => {
        const [results] = await searchCollectivesInDB(
          makeRequest(fixture.randomUser),
          'AVeryUniquePrivateCollectiveSearchName',
          0,
          100,
        );
        expect(results.find(c => c.id === fixture.privateCollective.id)).to.not.exist;
      });
      it('returns private collectives to root admins', async () => {
        const [results] = await searchCollectivesInDB(
          makeRequest(fixture.rootAdmin),
          'AVeryUniquePrivateCollectiveSearchName',
          0,
          100,
        );
        expect(results.find(c => c.id === fixture.privateCollective.id)).to.exist;
      });

      it('returns private projects to parent collective admins', async () => {
        const [results] = await searchCollectivesInDB(
          makeRequest(fixture.privateCollectiveAdmin),
          'AVeryUniquePrivateProjectSearchName',
          0,
          100,
        );
        expect(results.find(c => c.id === fixture.privateProject.id)).to.exist;
      });

      it('returns private host organizations to admins of hosted collectives', async () => {
        const [results] = await searchCollectivesInDB(
          makeRequest(fixture.privateCollectiveAdmin),
          'AVeryUniquePrivateHostSearchName',
          0,
          100,
        );
        expect(results.find(c => c.id === fixture.privateHost.id)).to.exist;
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
        const [collectives] = await searchCollectivesInDB(publicReq, 'New Host', 0, 10, {
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
        const [collectives] = await searchCollectivesInDB(publicReq, '', 0, 10, {
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
        const [collectives] = await searchCollectivesInDB(publicReq, '', 0, 10, {
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

        const [collectives] = await searchCollectivesInDB(publicReq, '', 0, 10, {
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

    it('detects public ids', () => {
      expect(parseSearchTerm('acc_xyz789')).to.deep.equal({
        type: 'publicId',
        term: 'acc_xyz789',
        prefix: EntityShortIdPrefix.Collective,
      });
      expect(parseSearchTerm('tir_importrow')).to.deep.equal({
        type: 'publicId',
        term: 'tir_importrow',
        prefix: EntityShortIdPrefix.TransactionsImportRow,
      });
    });

    it('goes back to text for everything else', () => {
      expect(parseSearchTerm('')).to.deep.equal({ type: 'text', term: '' });
      expect(parseSearchTerm('test')).to.deep.equal({ type: 'text', term: 'test', words: 1 });
      expect(parseSearchTerm('A123')).to.deep.equal({ type: 'text', term: 'A123', words: 1 });
      expect(parseSearchTerm('test-hyphen')).to.deep.equal({ type: 'text', term: 'test-hyphen', words: 2 });
      expect(parseSearchTerm('#4242 not an id')).to.deep.equal({ type: 'text', term: '#4242 not an id', words: 4 });
      expect(parseSearchTerm('@slug not a slug')).to.deep.equal({ type: 'text', term: '@slug not a slug', words: 4 });
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

    const testBuildSearchConditionsWithCustomConfig = (searchTerm, fieldsConfig) => {
      return buildSearchConditions(searchTerm, fieldsConfig);
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

    it('build conditions for public ids when publicIdFields match the prefix', () => {
      const publicId = 'acc_searchPubId';
      const term = `%${sanitizeSearchTermForILike(publicId)}%`;
      const base = {
        ...TEST_FIELDS_CONFIGURATION,
        publicIdFields: [{ field: 'publicId', prefix: EntityShortIdPrefix.Collective }],
      };
      expect(buildSearchConditions(publicId, base)).to.deep.eq([
        { publicId },
        {
          slug: {
            [Op.iLike]: term,
          },
        },
        {
          '$fromCollective.slug$': {
            [Op.iLike]: term,
          },
        },
        {
          name: {
            [Op.iLike]: term,
          },
        },
        {
          '$fromCollective.name$': {
            [Op.iLike]: term,
          },
        },
        {
          tags: {
            [Op.overlap]: [publicId],
          },
        },
      ]);

      expect(
        buildSearchConditions(publicId, {
          ...base,
          publicIdFields: [
            { field: 'publicId', prefix: EntityShortIdPrefix.Collective },
            { field: 'mirrorPublicId', prefix: EntityShortIdPrefix.Collective },
          ],
        }),
      ).to.deep.eq([
        { publicId },
        { mirrorPublicId: publicId },
        {
          slug: {
            [Op.iLike]: term,
          },
        },
        {
          '$fromCollective.slug$': {
            [Op.iLike]: term,
          },
        },
        {
          name: {
            [Op.iLike]: term,
          },
        },
        {
          '$fromCollective.name$': {
            [Op.iLike]: term,
          },
        },
        {
          tags: {
            [Op.overlap]: [publicId],
          },
        },
      ]);

      expect(
        buildSearchConditions(publicId, {
          ...base,
          publicIdFields: [{ field: ['publicId', 'Collective.publicId'], prefix: EntityShortIdPrefix.Collective }],
        }),
      ).to.deep.eq([
        { publicId },
        { 'Collective.publicId': publicId },
        {
          slug: {
            [Op.iLike]: term,
          },
        },
        {
          '$fromCollective.slug$': {
            [Op.iLike]: term,
          },
        },
        {
          name: {
            [Op.iLike]: term,
          },
        },
        {
          '$fromCollective.name$': {
            [Op.iLike]: term,
          },
        },
        {
          tags: {
            [Op.overlap]: [publicId],
          },
        },
      ]);
    });

    it('returns no conditions for public ids when publicIdFields exist but none match the prefix', () => {
      const publicId = 'tx_abc123';
      const term = `%${sanitizeSearchTermForILike(publicId)}%`;
      expect(
        buildSearchConditions(publicId, {
          slugFields: ['slug'],
          textFields: ['name', 'description'],
          publicIdFields: [{ field: 'publicId', prefix: EntityShortIdPrefix.Collective }],
        }),
      ).to.deep.eq([
        {
          slug: {
            [Op.iLike]: term,
          },
        },
        {
          name: {
            [Op.iLike]: term,
          },
        },
        {
          description: {
            [Op.iLike]: term,
          },
        },
      ]);
    });

    it('treats public ids like text when publicIdFields is not configured', () => {
      const publicId = 'acc_noExclusiveFields';
      const iLike = `%${sanitizeSearchTermForILike(publicId)}%`;
      expect(testBuildSearchConditions(publicId)).to.deep.eq([
        { slug: { [Op.iLike]: iLike } },
        { '$fromCollective.slug$': { [Op.iLike]: iLike } },
        { name: { [Op.iLike]: iLike } },
        { '$fromCollective.name$': { [Op.iLike]: iLike } },
        { tags: { [Op.overlap]: [publicId] } },
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

  describe('buildKyselySearchConditions', () => {
    const compileWithSearch = (searchTerm: string, config: Parameters<typeof buildKyselySearchConditions>[1]) => {
      const kysely = getKysely();
      const query = buildKyselySearchConditions(searchTerm, config)(kysely.selectFrom('Orders').selectAll('Orders'));
      return query.compile();
    };

    it('returns query unchanged for an empty search', () => {
      const { sql: compiledSql, parameters } = compileWithSearch('', { textFields: ['name'] });
      expect(compiledSql).to.not.include('ilike');
      expect(parameters).to.be.empty;
    });

    it('applies no search filter when no fields apply to the parsed term', () => {
      const { sql: compiledSql, parameters } = compileWithSearch('#4242', {});
      expect(compiledSql).to.not.include('ilike');
      expect(compiledSql).to.not.include('"Orders"."id"');
      expect(parameters).to.not.include(4242);
      expect(parameters).to.include(true);
    });

    it('builds exclusive id condition for #id', () => {
      const { sql: compiledSql, parameters } = compileWithSearch('#4242', { idFields: ['Orders.id'] });
      expect(compiledSql).to.include('"Orders"."id"');
      expect(compiledSql).to.not.include('ilike');
      expect(parameters).to.include(4242);
    });

    it('builds exclusive slug condition for @slug', () => {
      const { sql: compiledSql, parameters } = compileWithSearch('@betree', { slugFields: ['slug'] });
      expect(compiledSql).to.include('"slug"');
      expect(compiledSql).to.not.include('ilike');
      expect(parameters).to.include('betree');
    });

    it('builds exclusive publicId condition without inclusive ILIKE (Kysely deviation)', () => {
      const publicId = 'acc_searchPubId';
      const { sql: compiledSql, parameters } = compileWithSearch(publicId, {
        slugFields: ['slug'],
        textFields: ['name'],
        publicIdFields: [{ field: 'publicId', prefix: EntityShortIdPrefix.Collective }],
      });
      expect(compiledSql).to.include('"publicId"');
      expect(compiledSql).to.not.include('ilike');
      expect(parameters).to.include(publicId);
    });

    it('falls through to inclusive ILIKE when publicId prefix does not match', () => {
      const publicId = 'tx_abc123';
      const { sql: compiledSql } = compileWithSearch(publicId, {
        slugFields: ['slug'],
        textFields: ['name'],
        publicIdFields: [{ field: 'publicId', prefix: EntityShortIdPrefix.Collective }],
      });
      expect(compiledSql).to.include('ilike');
    });

    it('builds inclusive conditions for numbers including id and amount', () => {
      const { sql: compiledSql, parameters } = compileWithSearch('4242', {
        slugFields: ['slug'],
        textFields: ['name'],
        idFields: ['Orders.id'],
        amountFields: ['totalAmount'],
        stringArrayFields: ['tags'],
      });
      expect(compiledSql).to.include('ilike');
      expect(compiledSql).to.include('"Orders"."id"');
      expect(compiledSql).to.include('"totalAmount"');
      expect(parameters).to.include(4242);
      expect(parameters).to.include(424200);
    });

    it('includes jsonb sql expression in textFields ILIKE OR', () => {
      const { sql: compiledSql } = compileWithSearch('PO-123', {
        textFields: [sql`"Orders".data->>'ponumber'`],
      });
      expect(compiledSql).to.include(`"Orders".data->>'ponumber'`);
      expect(compiledSql).to.include('ilike');
    });

    it('uses exact match for dataFields on single-word text', () => {
      const { sql: compiledSql, parameters } = compileWithSearch('ref_abc', {
        dataFields: ['data.reference'],
      });
      expect(compiledSql).to.include('"data"."reference"');
      expect(compiledSql).to.not.include('ilike');
      expect(parameters).to.include('ref_abc');
    });

    it('falls through to inclusive ILIKE when email type has empty emailFields', () => {
      const { sql: compiledSql, parameters } = compileWithSearch('a@b.com', {
        emailFields: [],
        textFields: ['data.email'],
      });
      expect(compiledSql).to.include('ilike');
      expect(compiledSql).to.include('"data"."email"');
      expect(parameters).to.not.include('a@b.com');
    });

    it('builds exclusive email condition when emailFields is set', () => {
      const email = 'contributor@example.com';
      const { sql: compiledSql, parameters } = compileWithSearch(email, {
        emailFields: ['Users.email'],
        textFields: ['description'],
      });
      expect(compiledSql).to.include('"Users"."email"');
      expect(compiledSql).to.not.include('ilike');
      expect(parameters).to.include(email);
    });
  });
});
