import { assert, expect } from 'chai';

import { sanitizeTags, validateTags } from '../../../server/lib/tags';

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

  describe('validateTags', () => {
    it('accepts up to the max number of tags', () => {
      expect(() => validateTags(['a', 'b', 'c'], { maxNbTags: 3 })).to.not.throw();
    });

    it('tells how many tags to remove when there are too many', () => {
      expect(() => validateTags(['a', 'b', 'c', 'd', 'e'], { maxNbTags: 3 })).to.throw(
        "Sorry, you can't add more than 3 tags. Please remove 2 tag(s).",
      );
    });
  });
});
