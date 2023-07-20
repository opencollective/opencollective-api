import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';

import { fakeCollective, randStr } from '../../../test-helpers/fake-data.js';
import * as utils from '../../../utils.js';

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
    const collectiveSearchQuery = gql`
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
    const collectiveSearchQuery = gql`
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
  });
});
