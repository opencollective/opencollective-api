import { expect } from 'chai';
import gqlV1 from 'fake-tag';
import { describe, it } from 'mocha';
import sinon from 'sinon';

import { sequelize } from '../../../../server/models';
import { fakeActiveHost, fakeCollective, fakeUser, fakeVendor, randStr } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/graphql/v1/search', () => {
  let collectives, commonKeyword;

  before(async () => {
    await utils.resetTestDB();
    commonKeyword = randStr();
    collectives = await Promise.all([
      fakeCollective({ name: randStr(), description: `A common keyword: ${commonKeyword}` }),
      fakeCollective({ name: randStr(), description: `A common keyword: ${commonKeyword}` }),
      fakeCollective({ name: randStr(), description: `A common keyword: ${commonKeyword}` }),
    ]);
  });

  it('returns list of CollectiveSearch types', async () => {
    const collectiveSearchQuery = gqlV1 /* GraphQL */ `
      query CollectiveSearch($term: String!) {
        search(term: $term) {
          collectives {
            id
          }
        }
      }
    `;

    let result = await utils.graphqlQuery(collectiveSearchQuery, { term: commonKeyword });
    let returnedCollectives = result.data.search.collectives.map(c => c.id).sort();
    expect(returnedCollectives).to.deep.equal(collectives.map(c => c.id).sort());

    result = await utils.graphqlQuery(collectiveSearchQuery, { term: collectives[0].name });
    returnedCollectives = result.data.search.collectives;
    expect(returnedCollectives.length).to.equal(1);
    expect(returnedCollectives[0].id).to.equal(collectives[0].id);
  });

  it('accepts limit and offset arguments', async () => {
    const collectiveSearchQuery = gqlV1 /* GraphQL */ `
      query CollectiveSearch($term: String!, $limit: Int!, $offset: Int!) {
        search(term: $term, limit: $limit, offset: $offset) {
          collectives {
            id
            name
            description
          }
          total
          limit
          offset
        }
      }
    `;

    const result = await utils.graphqlQuery(collectiveSearchQuery, { term: commonKeyword, limit: 2, offset: 0 });

    expect(result.data.search.collectives.length).to.equal(2);
    expect(result.data.search.total).to.equal(3);
  });

  describe('total', () => {
    const isCountQuery = (query: unknown) =>
      typeof query === 'string' && query.includes('SELECT COUNT(*)::int AS total');
    let querySpy: sinon.SinonSpy;

    beforeEach(() => {
      querySpy = sinon.spy(sequelize, 'query');
    });

    afterEach(() => {
      querySpy.restore();
    });

    it('is not counted when the field is not requested', async () => {
      const query = gqlV1 /* GraphQL */ `
        query CollectiveSearchWithoutTotal($term: String!) {
          search(term: $term) {
            collectives {
              id
            }
          }
        }
      `;

      const result = await utils.graphqlQuery(query, { term: commonKeyword });
      expect(result.errors).to.not.exist;
      expect(result.data.search.collectives).to.have.length(3);
      expect(querySpy.getCalls().filter(call => isCountQuery(call.args[0]))).to.be.empty;
    });

    it('is counted once when requested', async () => {
      const query = gqlV1 /* GraphQL */ `
        query CollectiveSearchWithTotal($term: String!) {
          search(term: $term, limit: 1) {
            collectives {
              id
            }
            total
          }
        }
      `;

      const result = await utils.graphqlQuery(query, { term: commonKeyword });
      expect(result.errors).to.not.exist;
      expect(result.data.search.collectives).to.have.length(1);
      expect(result.data.search.total).to.equal(3);
      expect(querySpy.getCalls().filter(call => isCountQuery(call.args[0]))).to.have.length(1);
    });

    it('is 1 for a search by public ID', async () => {
      const query = gqlV1 /* GraphQL */ `
        query CollectiveSearchByPublicId($term: String!) {
          search(term: $term) {
            collectives {
              id
            }
            total
          }
        }
      `;

      const result = await utils.graphqlQuery(query, { term: collectives[0].publicId });
      expect(result.errors).to.not.exist;
      expect(result.data.search.collectives.map(c => c.id)).to.deep.eq([collectives[0].id]);
      expect(result.data.search.total).to.equal(1);
    });
  });

  describe('vendor WHERE-scope filter', () => {
    // The picker passes `vendorVisibleToAccountIds` to narrow vendor results to the paying
    // account. Non-admins are filtered by scope; host admins bypass the filter and see every
    // vendor of the host (symmetric with `Host.vendors` v2 and `canUserUseVendor`).
    const vendorSearchQuery = gqlV1 /* GraphQL */ `
      query CollectiveSearchVendors($term: String!, $includeVendorsForHostId: Int!, $vendorVisibleToAccountIds: [Int]) {
        search(
          term: $term
          includeVendorsForHostId: $includeVendorsForHostId
          vendorVisibleToAccountIds: $vendorVisibleToAccountIds
          types: [VENDOR]
        ) {
          collectives {
            id
            name
          }
        }
      }
    `;

    let host, hostAdmin, inScopeCollective, otherCollective, inScopeVendor, otherScopedVendor, vendorTerm;
    before(async () => {
      hostAdmin = await fakeUser();
      host = await fakeActiveHost({ admin: hostAdmin });
      inScopeCollective = await fakeCollective({ HostCollectiveId: host.id });
      otherCollective = await fakeCollective({ HostCollectiveId: host.id });
      vendorTerm = randStr();
      inScopeVendor = await fakeVendor({
        ParentCollectiveId: host.id,
        name: `${vendorTerm}-in-scope`,
        data: { canBeUsedWithAccountIds: [inScopeCollective.id] },
      });
      otherScopedVendor = await fakeVendor({
        ParentCollectiveId: host.id,
        name: `${vendorTerm}-other-scope`,
        data: { canBeUsedWithAccountIds: [otherCollective.id] },
      });
    });

    it('non-admin: only returns vendors in the requested account scope', async () => {
      const result = await utils.graphqlQuery(vendorSearchQuery, {
        term: vendorTerm,
        includeVendorsForHostId: host.id,
        vendorVisibleToAccountIds: [inScopeCollective.id],
      });

      result.errors && console.error(result.errors);
      const ids = result.data.search.collectives.map(c => c.id).sort();
      expect(ids).to.deep.equal([inScopeVendor.id]);
    });

    it('host admin: bypasses the scope filter and returns all of the host vendors', async () => {
      const result = await utils.graphqlQuery(
        vendorSearchQuery,
        {
          term: vendorTerm,
          includeVendorsForHostId: host.id,
          vendorVisibleToAccountIds: [inScopeCollective.id],
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors);
      const ids = result.data.search.collectives.map(c => c.id).sort();
      expect(ids).to.deep.equal([inScopeVendor.id, otherScopedVendor.id].sort());
    });
  });
});
