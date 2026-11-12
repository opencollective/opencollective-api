import { expect } from 'chai';
import { GraphQLError } from 'graphql';
import { DatabaseError as PgDatabaseError } from 'pg';
import { DatabaseError, ForeignKeyConstraintError, UniqueConstraintError } from 'sequelize';

import { formatGraphQLError } from '../../../server/graphql/format-error';
import { DATABASE_ERROR_PUBLIC_MESSAGE } from '../../../server/lib/database-errors';
import { sequelize } from '../../../server/models';

const toApolloArgs = (originalError: Error) => {
  const error = new GraphQLError(originalError.message, { originalError, path: ['orders'] });
  const formattedError = { ...error.toJSON(), extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['...'] } };
  return [formattedError, error] as const;
};

describe('server/graphql/format-error', () => {
  it('masks errors raised by Postgres through Sequelize', async () => {
    const originalError = await sequelize.query('SELECT * FROM "Orders" WHERE id = 99999999999::integer').catch(e => e);
    expect(originalError).to.be.instanceOf(DatabaseError);

    const result = formatGraphQLError(...toApolloArgs(originalError));
    expect(result.message).to.eq(DATABASE_ERROR_PUBLIC_MESSAGE);
    expect(result.path).to.deep.eq(['orders']);
    expect(result.extensions).to.deep.eq({ code: 'INTERNAL_SERVER_ERROR' });
    expect(JSON.stringify(result)).to.not.include('out of range');
  });

  it('masks Sequelize database error subclasses and raw pg errors', () => {
    const fkError = new ForeignKeyConstraintError({
      message: 'violates foreign key constraint "Orders_CollectiveId_fkey"',
    });
    const pgError = new PgDatabaseError('relation "Secrets" does not exist', 0, 'error');
    for (const error of [fkError, pgError, new Error('Wrapped', { cause: pgError })]) {
      expect(formatGraphQLError(...toApolloArgs(error)).message).to.eq(DATABASE_ERROR_PUBLIC_MESSAGE);
    }
  });

  it('does not mask other errors', () => {
    const forbidden = new GraphQLError('Nope', { extensions: { code: 'Forbidden' } });
    expect(formatGraphQLError(forbidden.toJSON(), forbidden)).to.deep.eq(forbidden.toJSON());
    expect(formatGraphQLError(...toApolloArgs(new Error('Something specific'))).message).to.eq('Something specific');
    // Validation errors are user-facing
    const uniqueError = new UniqueConstraintError({ message: 'Slug already taken' });
    expect(formatGraphQLError(...toApolloArgs(uniqueError)).message).to.eq('Slug already taken');
  });
});
