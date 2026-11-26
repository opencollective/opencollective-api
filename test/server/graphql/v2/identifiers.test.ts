import { expect } from 'chai';

import type { IdentifierType } from '../../../../server/graphql/v2/identifiers';
import * as identifiers from '../../../../server/graphql/v2/identifiers';

/** `transaction` is not a registered identifier type, but `idEncode`/`idDecode` accept arbitrary types. */
const TRANSACTION_TYPE = 'transaction' as IdentifierType;

describe('server/graphql/v2/identifiers', () => {
  it('encodes then decodes a numerical id', () => {
    expect(identifiers.idDecode(identifiers.idEncode(10, TRANSACTION_TYPE), TRANSACTION_TYPE)).to.equal(10);
  });
});
