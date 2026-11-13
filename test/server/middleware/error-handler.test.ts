import { expect } from 'chai';
import { DatabaseError } from 'sequelize';
import sinon from 'sinon';

import { DATABASE_ERROR_PUBLIC_MESSAGE } from '../../../server/lib/database-errors';
import errors from '../../../server/lib/errors';
import errorHandler from '../../../server/middleware/error-handler';
import { sequelize } from '../../../server/models';

const callErrorHandler = (err: Error) => {
  const res = { headersSent: false, header: sinon.stub(), status: sinon.stub(), send: sinon.stub() };
  res.status.returns(res);
  errorHandler(err, {} as never, res as never, sinon.stub());
  return { status: res.status.firstCall.args[0], body: JSON.parse(JSON.stringify(res.send.firstCall.args[0])) };
};

describe('server/middleware/error-handler', () => {
  it('does not leak database errors (message, SQL, parameters)', async () => {
    const dbError = await sequelize.query('SELECT * FROM "Orders" WHERE id = 99999999999::integer').catch(e => e);
    expect(dbError).to.be.instanceOf(DatabaseError);

    const { status, body } = callErrorHandler(dbError);
    expect(status).to.eq(500);
    expect(body.error.message).to.eq(DATABASE_ERROR_PUBLIC_MESSAGE);
    expect(JSON.stringify(body)).to.not.include('out of range');
    expect(JSON.stringify(body)).to.not.include('Orders');
  });

  it('returns other errors as-is', () => {
    const { status, body } = callErrorHandler(new errors.BadRequest('Invalid amount'));
    expect(status).to.eq(400);
    expect(body.error.message).to.eq('Invalid amount');
  });
});
