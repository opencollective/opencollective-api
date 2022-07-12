import { OAuthScope } from '../../server/graphql/v2/enum/OAuthScope';

type FieldDefinition = { description: string; deprecationReason: string | null };
const fieldsDefinition: Record<string, FieldDefinition> = OAuthScope['_nameLookup'];

console.log('## Scopes');
console.log('\n<!-- Use opencollective-api/scripts/docs/oauth.ts to update this section -->\n');
Object.entries(fieldsDefinition).forEach(([key, { description, deprecationReason }]) => {
  console.log(`- \`${key}\`: ${description}`);
  if (deprecationReason) {
    console.log(`  Deprecated: ${deprecationReason}`);
  }
});
