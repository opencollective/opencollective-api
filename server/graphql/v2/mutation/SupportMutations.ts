import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import emailLib from '../../../lib/email';
import { isValidEmail } from '../../../lib/utils';
import { ValidationFailed } from '../../errors';

const SUPPORT_EMAIL = 'support@opencollective.com';

const SupportResponse = new GraphQLObjectType({
  name: 'SupportResponse',
  fields: () => ({
    sent: {
      type: GraphQLBoolean,
    },
  }),
});

const supportMessageMutation = {
  sendMessage: {
    type: new GraphQLNonNull(SupportResponse),
    description: 'Send help and support message',
    args: {
      name: {
        type: new GraphQLNonNull(GraphQLString),
      },
      email: {
        type: new GraphQLNonNull(GraphQLString),
      },
      topic: {
        type: new GraphQLNonNull(GraphQLString),
      },
      message: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    resolve: async (_, args): Promise<Record<string, unknown>> => {
      if (!isValidEmail(args.email)) {
        throw new ValidationFailed('Provide a valid email');
      }

      const subject = 'New support message';

      const emailBody = `
          Name: <strong>${args.name}</strong></br>
          Email: <strong>${args.email}</strong></br>
          Topic: <strong>${args.topic}</strong></br></br>

          ${args.message}
      `;

      await emailLib.sendMessage(SUPPORT_EMAIL, subject, emailBody);

      return {
        sent: true,
      };
    },
  },
};

export default supportMessageMutation;
