import { expect } from 'chai';

import { POSTGRES_LOCK_NAMESPACES } from '../../../server/constants/postgres-locks';

describe('server/constants/postgres-locks', () => {
  it('has unique namespaces', () => {
    const values = Object.values(POSTGRES_LOCK_NAMESPACES);
    expect(new Set(values).size).to.eq(values.length);
  });

  it('only has namespaces that fit in a Postgres int4', () => {
    for (const value of Object.values(POSTGRES_LOCK_NAMESPACES)) {
      expect(Number.isInteger(value)).to.be.true;
      expect(value).to.be.within(-(2 ** 31), 2 ** 31 - 1);
    }
  });
});
