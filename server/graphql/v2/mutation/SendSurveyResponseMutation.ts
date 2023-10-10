import config from 'config';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import { RateLimitExceeded, Unauthorized, UnexpectedError } from '../../errors';

export const sendSurveyResponseMutation = {
  type: GraphQLBoolean,
  description: 'Send In-App Survey response',
  args: {
    surveyKey: {
      type: new GraphQLNonNull(GraphQLString),
    },
    responseId: {
      type: new GraphQLNonNull(GraphQLString),
    },
    score: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    text: {
      type: GraphQLString,
    },
    okToContact: {
      type: GraphQLBoolean,
    },
  },
  resolve: async (_, args, req) => {
    if (!req.remoteUser) {
      throw new Unauthorized();
    }
    const CODA_TOKEN = process.env.CODA_IN_APP_SURVEY_TOKEN;

    if (!CODA_TOKEN) {
      throw new UnexpectedError('Missing CODA_IN_APP_SURVEY_TOKEN');
    }

    const rateLimit = new RateLimit(`survey-response-${req.remoteUser.id}`, 60, ONE_HOUR_IN_SECONDS);

    if (!(await rateLimit.registerCall())) {
      throw new RateLimitExceeded();
    }

    const CODA_DOC_ID = 'nHLKv7oLV0';
    const CODA_TABLE_ID = 'grid-MhR5NN0eU6';
    const COLUMNS = {
      SurveyKey: 'c-hFDJoezlOg',
      ResponseId: 'c-K0P6anONBT',
      Score: 'c-IpWdMM0NdP',
      Text: 'c-yQHg7ZQE1s',
      AccountSlug: 'c-tJXqDf6PYR',
      OkToContact: 'c-hv9_LpI7WD',
      Environment: 'c-QCFYWyH3Dq',
    };

    try {
      await fetch(`https://coda.io/apis/v1/docs/${CODA_DOC_ID}/tables/${CODA_TABLE_ID}/rows`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CODA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rows: [
            {
              cells: [
                { column: COLUMNS.SurveyKey, value: args.surveyKey ?? '' },
                { column: COLUMNS.ResponseId, value: args.responseId ?? '' },
                { column: COLUMNS.Score, value: args.score ?? '' },
                { column: COLUMNS.Text, value: args.text ?? '' },
                { column: COLUMNS.AccountSlug, value: req.remoteUser.collective.slug },
                { column: COLUMNS.OkToContact, value: args.okToContact ?? false },
                { column: COLUMNS.Environment, value: config.env },
              ],
            },
          ],
          keyColumns: [COLUMNS.ResponseId],
        }),
      });
      return true;
    } catch (error) {
      throw new UnexpectedError(error);
    }
  },
};
