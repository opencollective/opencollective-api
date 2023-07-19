import { assert } from 'chai';

import { sanitizeTags } from '../../../server/lib/tags.js';

describe('server/lib/tags', () => {
  it('sanitize tags', () => {
    const tags = [
      'OpenCollective',
      '#OpenCollective',
      'o#penCollective',
      'OpenCollective#',
      '##OpenCollective',
      'opencollective, javascript, React', // Should split up tags that contain commas
      ' test ',
      'double  space',
      '    ', // Empty should be removed
      'OpEn-SoUrCe', // Should be unified under "open source"
    ];
    const sanitizedTags = sanitizeTags(tags);
    assert.deepEqual(sanitizedTags, [
      'opencollective',
      'o#pencollective',
      'opencollective#',
      'javascript',
      'react',
      'test',
      'double space',
      'open source',
    ]);
  });
});
