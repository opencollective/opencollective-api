import { expect } from 'chai';

import { OpenSearchModelsAdapters } from '../../../../server/lib/open-search/adapters';
import { OpenSearchIndexName } from '../../../../server/lib/open-search/constants';
import {
  buildDefaultTextShouldClauses,
  buildPrivateFieldShouldClauses,
  buildTextShouldClauses,
  buildTrustFunctionScore,
  isSlugLikeSearchTerm,
  shouldUseFuzziness,
} from '../../../../server/lib/open-search/query-builder';
import { buildQuery } from '../../../../server/lib/open-search/search';

describe('server/lib/open-search/search', () => {
  describe('buildDefaultTextShouldClauses', () => {
    it('does not emit match_phrase for single-word queries', () => {
      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.COLLECTIVES];
      const clauses = buildDefaultTextShouldClauses(adapter, 'incredible', ['slug', 'name', 'description']);

      expect(clauses.some(clause => 'match_phrase' in clause)).to.be.false;
      expect(clauses.some(clause => 'term' in clause && clause.term?.slug)).to.be.true;
      expect(clauses.some(clause => 'multi_match' in clause)).to.be.true;
    });

    it('emits match_phrase for multi-word queries', () => {
      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.COLLECTIVES];
      const clauses = buildDefaultTextShouldClauses(adapter, 'bossa nova', ['slug', 'name', 'description']);

      expect(clauses.some(clause => 'match_phrase' in clause)).to.be.true;
      expect(clauses.some(clause => 'term' in clause && clause.term?.['name.keyword'])).to.be.true;
    });

    it('keeps website searchable but excludes type and countryISO from text search', () => {
      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.COLLECTIVES];
      const publicFields = Object.keys(adapter.mappings.properties).filter(
        field =>
          adapter.weights[field] !== 0 &&
          ['keyword', 'text'].includes(adapter.mappings.properties[field].type as string),
      );

      expect(publicFields).to.include('website');
      expect(publicFields).to.not.include('type');
      expect(publicFields).to.not.include('countryISO');

      const clauses = buildDefaultTextShouldClauses(adapter, 'https://example.com', publicFields);
      expect(clauses.some(clause => 'term' in clause && clause.term?.website)).to.be.true;
      expect(clauses.some(clause => 'term' in clause && clause.term?.type)).to.be.false;
      expect(clauses.some(clause => 'term' in clause && clause.term?.countryISO)).to.be.false;
    });

    it('applies fuzziness only on the multi_match fallback', () => {
      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.COLLECTIVES];
      const clauses = buildDefaultTextShouldClauses(adapter, 'bossa nova', ['slug', 'name', 'description']);

      const multiMatch = clauses.find(clause => 'multi_match' in clause);
      expect(multiMatch?.multi_match?.fuzziness).to.eq('AUTO');

      const termClause = clauses.find(clause => 'term' in clause && clause.term?.slug);
      expect(termClause?.term?.slug).to.not.have.property('fuzziness');

      const phraseClause = clauses.find(clause => 'match_phrase' in clause);
      expect(phraseClause?.match_phrase?.name).to.not.have.property('fuzziness');
    });

    it('does not apply fuzziness on short queries', () => {
      expect(shouldUseFuzziness('ATX')).to.be.false;

      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.COLLECTIVES];
      const clauses = buildDefaultTextShouldClauses(adapter, 'ATX', ['slug', 'name', 'description']);
      const multiMatch = clauses.find(clause => 'multi_match' in clause);

      expect(multiMatch?.multi_match).to.not.have.property('fuzziness');
    });

    it('still applies fuzziness on longer queries', () => {
      expect(shouldUseFuzziness('incredible')).to.be.true;

      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.COLLECTIVES];
      const clauses = buildDefaultTextShouldClauses(adapter, 'incredible', ['slug', 'name', 'description']);
      const multiMatch = clauses.find(clause => 'multi_match' in clause);

      expect(multiMatch?.multi_match?.fuzziness).to.eq('AUTO');
    });
  });

  describe('isSlugLikeSearchTerm', () => {
    it('detects hyphenated slug-shaped queries', () => {
      expect(isSlugLikeSearchTerm('zslugpriority-xywtest-abcdef')).to.be.true;
      expect(isSlugLikeSearchTerm('atx-mental-health')).to.be.true;
    });

    it('does not treat short acronyms as slug-shaped queries', () => {
      expect(isSlugLikeSearchTerm('ATX')).to.be.false;
    });

    it('does not treat CamelCase names as slug-shaped queries', () => {
      expect(isSlugLikeSearchTerm('ExactNameMatchTarget')).to.be.false;
      expect(isSlugLikeSearchTerm('TrustRankingSharedName')).to.be.false;
    });

    it('does not treat natural language queries as slug-shaped', () => {
      expect(isSlugLikeSearchTerm('ATX mental health')).to.be.false;
    });
  });

  describe('buildTextShouldClauses for collectives', () => {
    const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.COLLECTIVES];
    const publicFields = ['slug', 'name', 'description'];

    it('emits prefix on slug for short acronym queries', () => {
      const clauses = buildTextShouldClauses(adapter, 'ATX', publicFields);
      const prefixClause = clauses.find(clause => 'prefix' in clause && clause.prefix?.slug);

      const slugPrefix = prefixClause?.prefix?.slug;
      expect(typeof slugPrefix === 'object' && slugPrefix !== null && 'value' in slugPrefix && slugPrefix.value).to.eq(
        'atx',
      );
    });

    it('emits prefix on slug for multi-word queries via slugify', () => {
      const clauses = buildTextShouldClauses(adapter, 'ATX mental health', publicFields);
      const prefixClause = clauses.find(clause => 'prefix' in clause && clause.prefix?.slug);

      const slugPrefix = prefixClause?.prefix?.slug;
      expect(typeof slugPrefix === 'object' && slugPrefix !== null && 'value' in slugPrefix && slugPrefix.value).to.eq(
        'atx-mental-health',
      );
    });

    it('emits match_bool_prefix on name', () => {
      const clauses = buildTextShouldClauses(adapter, 'ATX', publicFields);

      expect(clauses.some(clause => 'match_bool_prefix' in clause && clause.match_bool_prefix?.name)).to.be.true;
    });

    it('deprioritizes name for hyphenated slug lookups while keeping broad match', () => {
      const clauses = buildTextShouldClauses(adapter, 'zslugpriority-xywtest-abcdef', publicFields);

      expect(clauses.some(clause => 'match_bool_prefix' in clause)).to.be.false;
      expect(clauses.some(clause => 'term' in clause && clause.term?.['name.keyword'])).to.be.false;
      expect(clauses.some(clause => 'term' in clause && clause.term?.slug)).to.be.true;
      expect(clauses.some(clause => 'prefix' in clause && clause.prefix?.slug)).to.be.true;
      expect(clauses.some(clause => 'multi_match' in clause)).to.be.true;
    });
  });

  describe('buildQuery', () => {
    it('wraps collectives text query in function_score', () => {
      const { query } = buildQuery('incredible', [{ index: OpenSearchIndexName.COLLECTIVES }], null, null, null);
      const indexQuery = query.bool?.should?.[0];

      expect(indexQuery).to.have.property('function_score');
      expect(indexQuery.function_score.boost_mode).to.eq('sum');
      expect(indexQuery.function_score.score_mode).to.eq('sum');
      expect(indexQuery.function_score.functions).to.have.length(3);
    });

    it('does not wrap non-collectives indexes in function_score', () => {
      const { query } = buildQuery('incredible', [{ index: OpenSearchIndexName.TIERS }], null, null, null);
      const indexQuery = query.bool?.should?.[0];

      expect(indexQuery).to.not.have.property('function_score');
      expect(indexQuery).to.have.property('bool');
    });

    it('builds weighted private field should clauses', () => {
      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.EXPENSES];
      const clauses = buildPrivateFieldShouldClauses(adapter, 'secret reference', 'reference');

      expect(clauses.some(clause => 'match' in clause && typeof clause.match?.reference === 'object')).to.be.true;
      expect(
        clauses.some(
          clause =>
            'match' in clause &&
            typeof clause.match?.reference === 'object' &&
            clause.match.reference.fuzziness === 'AUTO',
        ),
      ).to.be.true;
    });

    it('omits fuzziness on private field matches for short queries', () => {
      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.EXPENSES];
      const clauses = buildPrivateFieldShouldClauses(adapter, 'ATX', 'reference');
      const matchClause = clauses.find(clause => 'match' in clause && clause.match?.reference);

      expect(matchClause?.match?.reference).to.not.have.property('fuzziness');
    });
  });

  describe('buildTrustFunctionScore', () => {
    it('uses additive boosting', () => {
      /* eslint-disable camelcase */
      const wrapped = buildTrustFunctionScore({ match_all: {} });
      /* eslint-enable camelcase */

      expect(wrapped.function_score.boost_mode).to.eq('sum');
      expect(wrapped.function_score.functions).to.deep.include.members([
        { filter: { term: { isFirstPartyHost: true } }, weight: 3 },
        { filter: { term: { isTrustedHost: true } }, weight: 2 },
        { filter: { term: { isVerified: true } }, weight: 1.5 },
      ]);
    });
  });
});
