import { expect } from 'chai';

import { deepJSONBSet } from '../../../server/lib/sql';

const normalizeStr = (str: string) =>
  str
    .replace(/\s+/g, ' ')
    .replace(/\s?([\(\)])\s?/g, (match, char) => char)
    .trim();

describe('server/lib/sql', () => {
  describe('deepJSONBSet', () => {
    it('should generate the correct SQL for a simple path', () => {
      const field = 'data';
      const path = ['foo'];
      const valueReplacementAlias = ':myValue';
      const expectedSQL = `
      JSONB_SET(
        COALESCE("data", '{}')::JSONB,
        '{foo}',
        :myValue
      )
    `;
      expect(deepJSONBSet(field, path, valueReplacementAlias)).to.eq(normalizeStr(expectedSQL));
    });

    it('should generate the correct SQL for a nested path', () => {
      const field = 'data';
      const path = ['foo', 'bar', 'baz'];
      const valueReplacementAlias = ':myValue';
      const expectedSQL = `
      JSONB_SET(
        COALESCE("data", '{}')::JSONB,
        '{foo}',
        JSONB_SET(
          COALESCE("data"#>>'{foo}', '{}')::JSONB,
          '{bar}',
          JSONB_SET(
            COALESCE("data"#>>'{foo,bar}', '{}')::JSONB,
            '{baz}',
            :myValue
          )
        )
      )
    `;
      expect(deepJSONBSet(field, path, valueReplacementAlias)).to.eq(normalizeStr(expectedSQL));
    });
  });
});
