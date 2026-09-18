import { expect } from 'chai';
import { isLosslessNumber } from 'lossless-json';

import {
  normalizeWiseId,
  normalizeWiseIdList,
  parseLosslessJson,
  safeLegacyNumericWiseId,
  stringifyLosslessJson,
  tryNormalizeWiseId,
  wiseIdListIncludes,
  wiseIdsEqual,
  wiseInt64,
} from '../../../server/lib/wise-id';

describe('server/lib/wise-id', () => {
  describe('normalizeWiseId', () => {
    it('canonicalizes decimal strings without losing digits', () => {
      expect(normalizeWiseId('9007199254740993')).to.equal('9007199254740993');
      expect(normalizeWiseId('9223372036854775807')).to.equal('9223372036854775807');
      expect(normalizeWiseId('-9223372036854775808')).to.equal('-9223372036854775808');
      expect(normalizeWiseId('00042')).to.equal('42');
    });

    it('accepts safe integer numbers and bigints', () => {
      expect(normalizeWiseId(1234)).to.equal('1234');
      expect(normalizeWiseId(9007199254740991)).to.equal('9007199254740991');
      expect(normalizeWiseId(9007199254740993n)).to.equal('9007199254740993');
    });

    it('rejects unsafe numbers because their digits cannot be proven', () => {
      // `Number('9007199254740993')` is exactly the lossy value we must refuse.
      expect(() => normalizeWiseId(Number('9007199254740993'))).to.throw(/unsafe Number/);
      expect(() => normalizeWiseId(Number.MAX_SAFE_INTEGER + 1)).to.throw(/unsafe Number/);
      expect(tryNormalizeWiseId(Number('9007199254740993'))).to.be.null;
    });

    it('rejects floats, empty values and other types', () => {
      expect(() => normalizeWiseId(12.5)).to.throw(/unsafe Number/);
      expect(() => normalizeWiseId('12.5')).to.throw(/Invalid Wise identifier/);
      expect(() => normalizeWiseId('')).to.throw(/Invalid Wise identifier/);
      expect(() => normalizeWiseId('abc')).to.throw(/Invalid Wise identifier/);
      expect(() => normalizeWiseId(null)).to.throw(/Invalid Wise identifier type/);
      expect(() => normalizeWiseId(undefined)).to.throw(/Invalid Wise identifier type/);
    });
  });

  describe('wiseIdsEqual', () => {
    it('matches across legacy numeric and canonical string representations', () => {
      expect(wiseIdsEqual(1234, '1234')).to.be.true;
      expect(wiseIdsEqual('9007199254740993', 9007199254740993n)).to.be.true;
      expect(wiseIdsEqual('9007199254740993', '9007199254740992')).to.be.false;
      expect(wiseIdsEqual('1234', '1235')).to.be.false;
    });

    it('does not throw on invalid/undefined values', () => {
      expect(wiseIdsEqual(undefined, '1234')).to.be.false;
      expect(wiseIdsEqual('abc', 'abc')).to.be.false;
    });
  });

  describe('normalizeWiseIdList / wiseIdListIncludes', () => {
    it('normalizes mixed legacy numeric/string lists', () => {
      expect(normalizeWiseIdList([1234, '5678', null, 'nope'])).to.deep.equal(['1234', '5678']);
    });

    it('matches mixed representations', () => {
      expect(wiseIdListIncludes([1234, '5678'], 5678)).to.be.true;
      expect(wiseIdListIncludes([1234, '5678'], '1234')).to.be.true;
      expect(wiseIdListIncludes(['9007199254740993'], 9007199254740993n)).to.be.true;
      expect(wiseIdListIncludes(['9007199254740993'], '9007199254740992')).to.be.false;
      expect(wiseIdListIncludes(undefined, 1)).to.be.false;
    });
  });

  describe('safeLegacyNumericWiseId', () => {
    it('returns the legacy numeric value for safe integers', () => {
      expect(safeLegacyNumericWiseId('220192')).to.equal(220192);
      expect(safeLegacyNumericWiseId(220192)).to.equal(220192);
      expect(safeLegacyNumericWiseId(220192n)).to.equal(220192);
    });

    it('refuses values that cannot be represented without rounding', () => {
      // 9007199254740993 is not a safe integer; returning a rounded number would conflate it with
      // its neighbour, so the fallback must be disabled for these values.
      expect(safeLegacyNumericWiseId('9007199254740993')).to.be.undefined;
      expect(safeLegacyNumericWiseId('9223372036854775807')).to.be.undefined;
      expect(safeLegacyNumericWiseId(9007199254740993n)).to.be.undefined;
    });

    it('returns undefined for invalid values', () => {
      expect(safeLegacyNumericWiseId('abc')).to.be.undefined;
      expect(safeLegacyNumericWiseId(undefined)).to.be.undefined;
    });
  });

  describe('parseLosslessJson', () => {
    it('keeps adjacent integers above Number.MAX_SAFE_INTEGER distinct', () => {
      const parsed = parseLosslessJson<{ first: string; second: string }>(
        '{"first": 9007199254740992, "second": 9007199254740993}',
      );
      expect(parsed).to.deep.equal({ first: '9007199254740992', second: '9007199254740993' });
      expect(parsed.first).to.not.equal(parsed.second);
    });

    it('preserves signed Int64 boundaries exactly', () => {
      const parsed = parseLosslessJson(
        '{"max": 9223372036854775807, "min": -9223372036854775808, "int32boundary": 2147483648}',
      );
      expect(parsed).to.deep.equal({
        max: '9223372036854775807',
        min: '-9223372036854775808',
        int32boundary: 2147483648,
      });
    });

    it('keeps safe integers and decimals as numbers', () => {
      const parsed = parseLosslessJson<Record<string, number>>(
        '{"safe": 1234, "maxSafe": 9007199254740991, "amount": 12.34, "rate": 0.9044, "exp": 1e3}',
      );
      expect(parsed).to.deep.equal({ safe: 1234, maxSafe: 9007199254740991, amount: 12.34, rate: 0.9044, exp: 1000 });
      expect(parsed.safe).to.be.a('number');
      expect(parsed.maxSafe).to.be.a('number');
      expect(parsed.amount).to.be.a('number');
    });

    it('preserves unsafe integers nested in objects and arrays', () => {
      const parsed = parseLosslessJson('{"items": [{"id": 9007199254740993}, {"id": 9007199254740992}], "ok": true}');
      expect(parsed).to.deep.equal({ items: [{ id: '9007199254740993' }, { id: '9007199254740992' }], ok: true });
    });

    it('does not touch digit sequences inside strings', () => {
      const parsed = parseLosslessJson('{"note": "id 9007199254740993 stays", "brace": "}{ \\" 9007199254740993"}');
      expect(parsed).to.deep.equal({ note: 'id 9007199254740993 stays', brace: '}{ " 9007199254740993' });
    });

    it('handles null/booleans and empty containers', () => {
      expect(parseLosslessJson('{"a": null, "b": false, "c": [], "d": {}}')).to.deep.equal({
        a: null,
        b: false,
        c: [],
        d: {},
      });
    });

    it('throws a SyntaxError for invalid JSON', () => {
      expect(() => parseLosslessJson('{not json')).to.throw(SyntaxError);
    });
  });

  describe('stringifyLosslessJson', () => {
    it('emits Wise int64 values as exact unquoted integer tokens', () => {
      const body = stringifyLosslessJson({
        targetAccount: wiseInt64('9223372036854775807'),
        quoteUuid: 'abc',
      });
      expect(body).to.equal('{"targetAccount":9223372036854775807,"quoteUuid":"abc"}');
    });

    it('emits bigint values as exact unquoted integer tokens', () => {
      expect(stringifyLosslessJson({ transferIds: [9007199254740993n] })).to.equal(
        '{"transferIds":[9007199254740993]}',
      );
    });

    it('omits undefined values like JSON.stringify', () => {
      expect(stringifyLosslessJson({ a: undefined, b: 1, c: undefined })).to.equal('{"b":1}');
    });

    it('round-trips unsafe integers through stringify and parse', () => {
      const body = stringifyLosslessJson({ id: wiseInt64('9007199254740993') });
      expect(parseLosslessJson(body)).to.deep.equal({ id: '9007199254740993' });
    });
  });

  describe('wiseInt64', () => {
    it('returns undefined when the value is undefined', () => {
      expect(wiseInt64(undefined)).to.be.undefined;
    });

    it('returns LosslessNumber values and normalizes string/number/bigint inputs', () => {
      expect(isLosslessNumber(wiseInt64('42'))).to.be.true;
      expect(wiseInt64(42)?.toString()).to.equal('42');
      expect(wiseInt64(42n)?.toString()).to.equal('42');
    });
  });
});
