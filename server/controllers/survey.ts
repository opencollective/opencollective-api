import { Request, Response } from 'express';

import errors from '../lib/errors';

export async function sendInAppSurveyResponse(
  req: Request<
    any,
    any,
    { surveyKey: string; responseId: string; score: string; text?: string; okToContact?: boolean }
  >,
  res: Response,
  next,
) {
  const {
    remoteUser,
    body: { surveyKey, responseId, score, text, okToContact },
  } = req;
  if (!remoteUser) {
    return next(new errors.Unauthorized());
  }
  if (!responseId) {
    return next(new errors.BadRequest('Missing survey response id'));
  }
  const CODA_TOKEN = process.env.CODA_IN_APP_SURVEY_TOKEN;
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

  // Getting column ids:
  // const cols = await fetch(`https://coda.io/apis/v1/docs/${CODA_DOC_ID}/tables/${CODA_TABLE_ID}/columns`, {
  //   method: 'GET',
  //   headers: {
  //     Authorization: `Bearer ${CODA_TOKEN}`,
  //     'Content-Type': 'application/json',
  //   },
  // });
  // console.log(await cols.json());

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
              { column: COLUMNS.SurveyKey, value: surveyKey ?? '' },
              { column: COLUMNS.ResponseId, value: responseId ?? '' },
              { column: COLUMNS.Score, value: score ?? '' },
              { column: COLUMNS.Text, value: text ?? '' },
              { column: COLUMNS.AccountSlug, value: remoteUser.collective.slug },
              { column: COLUMNS.OkToContact, value: okToContact ?? false },
              { column: COLUMNS.Environment, value: process.env.NODE_ENV },
            ],
          },
        ],
        keyColumns: [COLUMNS.ResponseId],
      }),
    });
    res.send({ status: 200 });
  } catch (error) {
    next(new errors.ServerError(error));
  }
}
