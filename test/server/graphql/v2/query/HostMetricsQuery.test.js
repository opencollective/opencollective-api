import { expect } from 'chai';
import gql from 'fake-tag';
import { useFakeTimers } from 'sinon';

import { processOrder } from '../../../../../server/lib/payments';
import { fakeCollective, fakeHost, fakeOrder, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

describe('server/graphql/v2/query/HostMetricsQuery', () => {
  before(resetTestDB);

  let host, collectiveAdminUser, hostAdminUser, collective1, collective2;

  const hostMetricsQuery = gql`
    query HostMetrics($slug: String!, $dateFrom: DateTime!, $dateTo: DateTime!, $account: [AccountReferenceInput!]) {
      host(slug: $slug) {
        id
        hostMetrics(dateFrom: $dateFrom, dateTo: $dateTo, account: $account) {
          hostFees {
            valueInCents
            currency
          }
          hostFeeShare {
            valueInCents
            currency
          }
          totalMoneyManaged {
            valueInCents
            currency
          }
        }
        hostMetricsTimeSeries(dateFrom: $dateFrom, dateTo: $dateTo, timeUnit: MONTH) {
          totalMoneyManaged {
            nodes {
              date
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
    await fakeCollective({
      id: 8686,
      slug: 'open-collective',
      HostCollectiveId: 8686,
    });
    collectiveAdminUser = await fakeUser();
    hostAdminUser = await fakeUser();
    host = await fakeHost({ plan: 'grow-plan-2021', createdAt: '2015-01-01' });
    await host.addUserWithRole(hostAdminUser, 'ADMIN');

    collective1 = await fakeCollective({ admin: collectiveAdminUser, HostCollectiveId: host.id, hostFeePercent: 30 });
    collective2 = await fakeCollective({ admin: collectiveAdminUser, HostCollectiveId: host.id, hostFeePercent: 30 });

    let clock = useFakeTimers(new Date('2021-02-01 0:0').getTime());
    try {
      const order1 = await fakeOrder({
        CollectiveId: collective1.id,
        totalAmount: 1000,
      });
      order1.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await processOrder(order1);
    } finally {
      clock.restore();
    }

    clock = useFakeTimers(new Date('2021-06-01 0:0').getTime());
    try {
      const order2 = await fakeOrder({
        CollectiveId: collective2.id,
        totalAmount: 2000,
      });
      order2.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await processOrder(order2);
    } finally {
      clock.restore();
    }
  });

  describe('hostMetricsQuery', () => {
    describe('hostMetrics', () => {
      it('correctly returns hostFees and hostFeeShare', async () => {
        const dateFrom = new Date('2019-01-01').toISOString();
        const dateTo = new Date().toISOString();
        const variables = { slug: host.slug, dateFrom, dateTo };
        const queryResponse = await graphqlQueryV2(hostMetricsQuery, variables);
        const hostMetrics = queryResponse.data.host.hostMetrics;
        expect(hostMetrics.hostFees.valueInCents).to.equal(900);
        expect(hostMetrics.hostFeeShare.valueInCents).to.equal(135);
      });

      it('correctly calculates hostFees and hostFeeShare based on date filter passed', async () => {
        const dateFrom = new Date('2021-04-01').toISOString();
        const dateTo = new Date().toISOString();
        const variables = { slug: host.slug, dateFrom, dateTo };
        const queryResponse = await graphqlQueryV2(hostMetricsQuery, variables);
        const hostMetrics = queryResponse.data.host.hostMetrics;
        expect(hostMetrics.hostFees.valueInCents).to.equal(600);
        expect(hostMetrics.hostFeeShare.valueInCents).to.equal(90);
      });

      it('correctly calculates hostFees and hostFeeShare based on collective filter passed', async () => {
        const dateFrom = new Date('2021-01-01').toISOString();
        const dateTo = new Date().toISOString();
        const variables = { slug: host.slug, dateFrom, dateTo, account: [{ legacyId: collective1.id }] };
        const queryResponse = await graphqlQueryV2(hostMetricsQuery, variables);
        const hostMetrics = queryResponse.data.host.hostMetrics;
        expect(hostMetrics.hostFees.valueInCents).to.equal(300);
        expect(hostMetrics.hostFeeShare.valueInCents).to.equal(45);
      });

      it('correctly calculates totalMoneyManaged for the whole period', async () => {
        const dateFrom = new Date(host.createdAt).toISOString();
        const dateTo = new Date().toISOString();
        const variables = { slug: host.slug, dateFrom, dateTo };
        const queryResponse = await graphqlQueryV2(hostMetricsQuery, variables);
        const hostMetrics = queryResponse.data.host.hostMetrics;
        const hostMetricsTimeSeriesNodes = queryResponse.data.host.hostMetricsTimeSeries.totalMoneyManaged.nodes;
        const totalMoneyManaged =
          hostMetricsTimeSeriesNodes.length > 0
            ? hostMetricsTimeSeriesNodes[hostMetricsTimeSeriesNodes.length - 1].amount.valueInCents
            : 0;
        expect(hostMetrics.totalMoneyManaged.valueInCents).to.equal(totalMoneyManaged);
      });

      it('correctly calculates totalMoneyManaged for a given month', async () => {
        const dateFrom = new Date(host.createdAt).toISOString();
        const dateTo = new Date('2021-03-01').toISOString();
        const variables = { slug: host.slug, dateFrom, dateTo };
        const queryResponse = await graphqlQueryV2(hostMetricsQuery, variables);
        const hostMetrics = queryResponse.data.host.hostMetrics;
        const hostMetricsTimeSeriesNodes = queryResponse.data.host.hostMetricsTimeSeries.totalMoneyManaged.nodes;
        const totalMoneyManaged =
          hostMetricsTimeSeriesNodes.length > 0
            ? hostMetricsTimeSeriesNodes[hostMetricsTimeSeriesNodes.length - 1].amount.valueInCents
            : 0;
        expect(hostMetrics.totalMoneyManaged.valueInCents).to.equal(totalMoneyManaged);
      });
    });
  });
});
