import { assert } from 'chai';

import { sanitizeTags } from '../../../server/lib/tags';

describe('server/lib/tags', () => {
  it('sanitize tags', () => {
    const tags = [
      'OpenCollective',
      '#OpenCollective',
      'o#penCollective',
      'OpenCollective#',
      '##OpenCollective',
      ' test ',
      'double  space',
    ];
    const sanitizedTags = sanitizeTags(tags);
    assert.deepEqual(sanitizedTags, ['opencollective', 'o#pencollective', 'opencollective#', 'test', 'double space']);
  });
});
