import { GraphQLEnumType } from 'graphql';

export const GraphQLImageFormat = new GraphQLEnumType({
  name: 'ImageFormat',
  values: {
    txt: {},
    png: {},
    jpg: {},
    gif: {},
    svg: {},
  },
});
