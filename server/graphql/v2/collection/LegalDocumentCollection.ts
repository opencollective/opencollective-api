import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLLegalDocument } from '../object/LegalDocument';

export const GraphQLLegalDocumentCollection = new GraphQLObjectType({
  name: 'LegalDocumentCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "LegalDocument"',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(GraphQLLegalDocument),
    },
  }),
});
