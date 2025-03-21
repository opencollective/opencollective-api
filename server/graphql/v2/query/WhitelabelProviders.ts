import { GraphQLList } from 'graphql';

import cache, { ONE_HOUR } from '../../../lib/cache';
import { Collective, Op } from '../../../models';
import { GraphQLAccount } from '../interface/Account';

const CACHE_KEY = 'whitelabel_providers';

const WhitelabelProvidersQuery = {
  type: new GraphQLList(GraphQLAccount),
  description: 'Return a list of all whitelabel providers',
  async resolve(): Promise<Collective[]> {
    const cached = await cache.get(CACHE_KEY);
    if (cached) {
      return cached;
    }

    const collectives = await Collective.findAll({
      where: {
        data: { whitelabel: { [Op.not]: null } },
      },
    });
    await cache.set(CACHE_KEY, collectives, ONE_HOUR);

    return collectives;
  },
};

export default WhitelabelProvidersQuery;
