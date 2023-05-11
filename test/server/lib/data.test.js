import { expect } from 'chai';

import { diffDBEntries } from '../../../server/lib/data';

// Models have a `get` method to access properties. We need to simulate that for old entries.
const simulateModel = data => {
  return { ...data, get: key => data[key] };
};

describe('server/lib/data', () => {
  it('works with empty lists', () => {
    const [toCreate, toRemove, toUpdate] = diffDBEntries([], [], []);
    expect(toCreate).to.eql([]);
    expect(toRemove).to.eql([]);
    expect(toUpdate).to.eql([]);
  });

  it('returns correct results', () => {
    const existingEntries = [
      simulateModel({ id: 1, msg: 'I am 1', date: new Date('2023-05-11T12:35:10.529Z') }),
      simulateModel({ id: 2, msg: 'I am 2', date: new Date('2023-05-11T12:35:10.529Z') }),
      simulateModel({ id: 3, msg: 'I am 3', date: new Date('2023-05-11T12:35:10.529Z') }),
    ];
    const newEntries = [
      { id: 1, msg: 'I am 1 edited', date: new Date('2023-05-11T12:35:10.529Z') },
      { id: 2, msg: 'I am 2', date: new Date('2023-05-11T12:35:10.529Z') },
      { msg: 'I am the new one!', date: new Date('2023-05-11T12:35:10.529Z') },
    ];
    const diffFields = ['msg'];

    const [toCreate, toRemove, toUpdate] = diffDBEntries(existingEntries, newEntries, diffFields);

    expect(toCreate).to.eql([{ msg: 'I am the new one!', date: new Date('2023-05-11T12:35:10.529Z') }]);
    expect(toRemove).to.eql([existingEntries[2]]);
    expect(toUpdate).to.eql([{ id: 1, msg: 'I am 1 edited', date: new Date('2023-05-11T12:35:10.529Z') }]);
  });

  it('throws if we try to update an unexisting entry', () => {
    const errorMsg = "One of the entity you're trying to update doesn't exist or has changes. Please refresh the page.";
    expect(() => diffDBEntries([], [{ id: 1, msg: 'Malicious entry' }], ['msg'])).to.throw(errorMsg);
  });
});
