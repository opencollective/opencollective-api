import { expect } from 'chai';
import gql from 'fake-tag';
import { createSandbox } from 'sinon';

import transferwise from '../../../../../server/paymentProviders/transferwise';
import { fakeActiveHost, fakeConnectedAccount, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const transferWiseQuery = gql`
  query Host($slug: String!) {
    host(slug: $slug) {
      id
      transferwise {
        id
        balances {
          valueInCents
          currency
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/TransferWise', () => {
  let sandbox;

  before(resetTestDB);
  beforeEach(() => {
    sandbox = createSandbox();
  });
  afterEach(() => {
    sandbox.restore();
  });

  const setupHostWithWise = async () => {
    const admin = await fakeUser();
    const host = await fakeActiveHost({ admin });
    await fakeConnectedAccount({ CollectiveId: host.id, service: 'transferwise' });
    return { host, admin };
  };

  describe('balances', () => {
    it('returns null for unauthenticated users', async () => {
      const { host } = await setupHostWithWise();
      const getAccountBalances = sandbox
        .stub(transferwise, 'getAccountBalances')
        .resolves([{ currency: 'USD', amount: { value: 100, currency: 'USD' } }] as any);

      const result = await graphqlQueryV2(transferWiseQuery, { slug: host.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.host.transferwise.balances).to.be.null;
      expect(getAccountBalances.called).to.be.false;
    });

    it('returns null for users who are not admins of the host', async () => {
      const { host } = await setupHostWithWise();
      const outsider = await fakeUser();
      const getAccountBalances = sandbox
        .stub(transferwise, 'getAccountBalances')
        .resolves([{ currency: 'USD', amount: { value: 100, currency: 'USD' } }] as any);

      const result = await graphqlQueryV2(transferWiseQuery, { slug: host.slug }, outsider);
      expect(result.errors).to.not.exist;
      expect(result.data.host.transferwise.balances).to.be.null;
      expect(getAccountBalances.called).to.be.false;
    });

    it('returns the balances for host admins', async () => {
      const { host, admin } = await setupHostWithWise();
      sandbox.stub(transferwise, 'getAccountBalances').resolves([
        { currency: 'USD', amount: { value: 100, currency: 'USD' } },
        { currency: 'EUR', amount: { value: 42.5, currency: 'EUR' } },
      ] as any);

      const result = await graphqlQueryV2(transferWiseQuery, { slug: host.slug }, admin);
      expect(result.errors).to.not.exist;
      expect(result.data.host.transferwise.balances).to.eql([
        { valueInCents: 10000, currency: 'USD' },
        { valueInCents: 4250, currency: 'EUR' },
      ]);
    });
  });
});
