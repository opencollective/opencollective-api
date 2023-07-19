import { expect } from 'chai';

import * as identifiers from '../../../../server/graphql/v2/identifiers.js';

describe('server/graphql/v2/identifiers', () => {
  it('encodes then decodes a numerical id', () => {
    expect(identifiers.idDecode(identifiers.idEncode(10, 'transaction'), 'transaction')).to.equal(10);
  });
});
