import { expect } from 'chai';

import {
  allowContextPermission,
  getContextPermission,
  PERMISSION_TYPE,
} from '../../../../server/graphql/common/context-permissions';
import { makeRequest } from '../../../utils';

describe('server/graphql/common/context-permissions', () => {
  let req;

  beforeEach(() => {
    req = makeRequest();
  });

  it('returns false by default', () => {
    expect(getContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DATA, 1)).to.be.false;
  });

  it('can allow permissions for individual entities', () => {
    allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DATA, 1);
    expect(getContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DATA, 1)).to.be.true;
    expect(getContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DATA, 2)).to.be.false;
  });

  it('raise an error if permission type is unknown', () => {
    expect(() => allowContextPermission(req, 'nope', 1)).to.throw();
    expect(() => getContextPermission(req, 'nope', 1)).to.throw();
  });
});
