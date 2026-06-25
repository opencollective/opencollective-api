import { expect } from 'chai';
import type { GraphQLResolveInfo } from 'graphql';
import { GraphQLString } from 'graphql';

import { defineProtectedField } from '../../../../server/graphql/common/define-protected-field';
import { Forbidden, Unauthorized } from '../../../../server/graphql/errors';

const resolveInfo = {} as GraphQLResolveInfo;

describe('defineProtectedField', () => {
  const baseConfig = {
    type: GraphQLString,
    resolve: () => 'ok',
  };

  it('rejects unauthenticated callers when requiresAuthentication is true', async () => {
    const field = defineProtectedField('test', { scopes: [], requiresAuthentication: true }, baseConfig);

    await expect(field.resolve(null, {}, { remoteUser: null } as Express.Request, resolveInfo)).to.be.rejectedWith(
      Unauthorized,
      'You need to be logged in.',
    );
  });

  it('rejects OAuth tokens when forbidOAuth is true', async () => {
    const field = defineProtectedField(
      'test',
      { scopes: [], requiresAuthentication: false, forbidOAuth: true },
      baseConfig,
    );

    await expect(
      field.resolve(null, {}, { remoteUser: {}, userToken: {} } as Express.Request, resolveInfo),
    ).to.be.rejectedWith(Forbidden, 'OAuth tokens cannot be used for this operation.');
  });

  it('rejects personal tokens when forbidPersonalTokens is true', async () => {
    const field = defineProtectedField(
      'test',
      { scopes: [], requiresAuthentication: false, forbidPersonalTokens: true },
      baseConfig,
    );

    await expect(
      field.resolve(null, {}, { remoteUser: {}, personalToken: {} } as Express.Request, resolveInfo),
    ).to.be.rejectedWith(Forbidden, 'Personal tokens cannot be used for this operation.');
  });

  it('stores resolved access control defaults in extensions', () => {
    const field = defineProtectedField('test', { scopes: ['transactions'], requiresAuthentication: false }, baseConfig);

    expect(field.extensions?.accessControl).to.deep.equal({
      scopes: ['transactions'],
      requiresAuthentication: false,
      forbidOAuth: false,
      forbidPersonalTokens: false,
    });
  });
});
