import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { fakeHost, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

describe('server/graphql/v2/query/HostQuery', () => {
  before(resetTestDB);

  let host, collectiveAdminUser, hostAdminUser, randomUser;

  const hostQuery = gqlV2/* GraphQL */ `
    query HostMetrics($slug: String!, $dateFrom: DateTime!, $dateTo: DateTime!) {
      host(slug: $slug) {
        id
        hostMetricsTimeSeries(dateFrom: $dateFrom, dateTo: $dateTo, timeUnit: MONTH) {
          hostFees {
            nodes {
              date
              amount {
                value
                valueInCents
                currency
              }
            }
          }
          hostFeeShare {
            nodes {
              date
              settlementStatus
              amount {
                value
                valueInCents
                currency
              }
            }
          }
        }
      }
    }
  `;

  before(async () => {
    host = await fakeHost();
    collectiveAdminUser = await fakeUser();
    hostAdminUser = await fakeUser();
    randomUser = await fakeUser();
    await host.addUserWithRole(collectiveAdminUser, 'ADMIN');
    await host.addUserWithRole(hostAdminUser, 'ADMIN');
    await host.addUserWithRole(randomUser, 'MEMBER');
  });

  describe('hostQuery', () => {
    describe('hostMetricsTimeSeries', () => {
      it('can only be fetched by admins', async () => {
        const dateFrom = new Date('2019-01-01').toISOString();
        const dateTo = new Date().toISOString();
        const variables = { slug: host.slug, dateFrom, dateTo };
        const queryResponse = await graphqlQueryV2(hostQuery, variables);
        const timeSeries = queryResponse.data.host.hostMetricsTimeSeries;
        expect(timeSeries.hostFees.nodes.length).to.equal(0);
        expect(timeSeries.hostFeeShare.nodes.length).to.equal(0);
      });

      it('gives time series', async () => {
        const dateFrom = new Date('2019-01-01').toISOString();
        const dateTo = new Date().toISOString();
        const variables = { slug: host.slug, dateFrom, dateTo };
        const queryResponse = await graphqlQueryV2(hostQuery, variables, hostAdminUser);
        console.log(queryResponse);
      });

      it('can be filtered by accounts', async () => {
        const dateFrom = new Date('2019-01-01').toISOString();
        const dateTo = new Date().toISOString();
        const variables = { slug: host.slug, dateFrom, dateTo };
        const queryResponse = await graphqlQueryV2(hostQuery, variables, hostAdminUser);
        console.log(queryResponse);
      });
    });
  });
});
