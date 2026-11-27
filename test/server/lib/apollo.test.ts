import { ApolloServer } from '@apollo/server';
import { expect } from 'chai';
import { GraphQLError } from 'graphql';
import sinon from 'sinon';

import { apolloSlowRequestCachePlugin } from '../../../server/lib/apollo';
import cache from '../../../server/lib/cache';

describe('server/lib/apollo', () => {
  describe('apolloSlowRequestCachePlugin', () => {
    let sandbox: sinon.SinonSandbox;
    let cacheSetStub: sinon.SinonStub;
    let server: ApolloServer;

    before(async () => {
      server = new ApolloServer({
        typeDefs: `type Query { hello: String, failing: String }`,
        resolvers: {
          Query: {
            hello: () => 'world',
            failing: () => {
              throw new GraphQLError('Resolver failed');
            },
          },
        },
        plugins: [apolloSlowRequestCachePlugin],
      });
      await server.start();
    });

    after(async () => {
      await server.stop();
    });

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      cacheSetStub = sandbox.stub(cache, 'set').resolves();
    });

    afterEach(() => {
      sandbox.restore();
    });

    /** Simulates a slow anonymous request that went through the GraphQL cache middleware (cache MISS) */
    const makeSlowCacheableContext = () => ({
      cacheKey: 'graphqlCache_test',
      startAt: new Date(Date.now() - 10_000),
      res: { set: sandbox.stub() },
    });

    const execute = (query: string) => server.executeOperation({ query }, { contextValue: makeSlowCacheableContext() });

    it('caches successful slow responses', async () => {
      const response = await execute('query { hello }');
      expect(response.body.kind).to.eq('single');
      expect(cacheSetStub.calledOnce).to.be.true;
      expect(cacheSetStub.firstCall.args[0]).to.eq('graphqlCache_test');
      expect(cacheSetStub.firstCall.args[1].data).to.deep.eq({ hello: 'world' });
      expect(cacheSetStub.firstCall.args[1].errors).to.be.undefined;
    });

    it('does not cache validation errors', async () => {
      const response = await execute('query { doesNotExist }');
      expect(response.body.kind === 'single' && response.body.singleResult.errors).to.have.length(1);
      expect(cacheSetStub.called).to.be.false;
    });

    it('does not cache responses with resolver errors (partial data)', async () => {
      const response = await execute('query { hello failing }');
      expect(response.body.kind === 'single' && response.body.singleResult.errors).to.have.length(1);
      expect(cacheSetStub.called).to.be.false;
    });

    it('does not cache requests without a cache key', async () => {
      await server.executeOperation(
        { query: 'query { hello }' },
        { contextValue: { ...makeSlowCacheableContext(), cacheKey: undefined } },
      );
      expect(cacheSetStub.called).to.be.false;
    });
  });
});
