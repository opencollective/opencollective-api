import { GraphQLOAuthScope } from '../../server/graphql/v2/enum/OAuthScope.js';

type FieldDefinition = { description: string; deprecationReason: string | null };
const fieldsDefinition: Record<string, FieldDefinition> = GraphQLOAuthScope['_nameLookup'];

console.log('## Scopes');
console.log('\n<!-- Use opencollective-api/scripts/docs/oauth.ts to update this section -->\n');
Object.entries(fieldsDefinition).forEach(([key, { description, deprecationReason }]) => {
  console.log(`- \`${key}\`: ${description}`);
  if (deprecationReason) {
    console.log(`  Deprecated: ${deprecationReason}`);
  }
});
