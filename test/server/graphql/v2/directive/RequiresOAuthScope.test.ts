import { expect } from 'chai';
import { getDirectiveValues } from 'graphql/execution/values';
import { printSchema } from 'graphql/utilities/printSchema';

import { RequiresOAuthScopeDirective } from '../../../../../server/graphql/v2/directive/RequiresOAuthScope';
import schemaV2 from '../../../../../server/graphql/v2/schema';

describe('RequiresOAuthScope directive', () => {
  it('is registered on the schema and printed in SDL', () => {
    const directive = schemaV2.getDirective('requiresOAuthScope');
    expect(directive).to.exist;
    expect(directive).to.equal(RequiresOAuthScopeDirective);

    const sdl = printSchema(schemaV2);
    expect(sdl).to.include('directive @requiresOAuthScope');
    expect(sdl).to.include('on FIELD_DEFINITION');
  });

  it('is attached to the transaction query field', () => {
    const field = schemaV2.getQueryType().getFields().transaction;

    expect(field.extensions?.accessControl).to.deep.equal({
      scopes: ['transactions'],
      requiresAuthentication: false,
      forbidOAuth: false,
      forbidPersonalTokens: false,
    });
    expect(field.astNode?.directives).to.have.lengthOf(1);

    const directiveValues = getDirectiveValues(RequiresOAuthScopeDirective, field.astNode, {});
    expect(directiveValues).to.deep.equal({ scopes: ['transactions'] });
  });
});
