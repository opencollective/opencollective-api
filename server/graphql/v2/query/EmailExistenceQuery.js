import config from 'config';
import { GraphQLBoolean, GraphQLString } from 'graphql';

import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import { isValidEmail } from '../../../lib/utils';
import models from '../../../models';

const EmailExistenceQuery = {
  type: GraphQLBoolean,
  args: {
    email: {
      type: GraphQLString,
      description: 'Email of user',
    },
  },
  async resolve(_, args, req) {
    const email = args.email?.toLowerCase();
    if (!isValidEmail(email)) {
      return false;
    } else {
      const rateLimit = new RateLimit(
        `user_email_search_ip_${req.ip}`,
        config.limits.searchEmailPerHourPerIp,
        ONE_HOUR_IN_SECONDS,
      );
      if (!(await rateLimit.registerCall())) {
        throw new Error('Rate limit exceeded');
      }
      const user = await models.User.findOne({
        attributes: ['id'],
        where: { email },
      });
      return Boolean(user);
    }
  },
};

export default EmailExistenceQuery;
