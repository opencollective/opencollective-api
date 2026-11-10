import { expect } from 'chai';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20261110120000-backfill-currency-exchange-rates-from-usd'; // eslint-disable-line import/default
import models, { sequelize } from '../../server/models';
import { resetTestDB } from '../utils';

describe('migrations/20261110120000-backfill-currency-exchange-rates-from-usd', () => {
  const day = new Date('2026-04-02T05:04:00Z');
  const rates = async (from: string) => {
    const rows = await models.CurrencyExchangeRate.findAll({ where: { from }, raw: true });
    return Object.fromEntries(rows.map(row => [row.to, row.rate]));
  };

  before(async () => {
    await resetTestDB();
    await models.CurrencyExchangeRate.bulkCreate([
      // USD rates, recorded every day
      { from: 'USD', to: 'USD', rate: 1, createdAt: day },
      { from: 'USD', to: 'EUR', rate: 0.9, createdAt: day },
      { from: 'USD', to: 'NZD', rate: 1.7, createdAt: day },
      { from: 'USD', to: 'MRO', rate: 40, createdAt: day },
      // EUR was recorded that day, NZD and MRO were not
      { from: 'EUR', to: 'USD', rate: 1.11, createdAt: day },
      // Before the gap: must not be backfilled
      { from: 'USD', to: 'NZD', rate: 1.6, createdAt: new Date('2026-03-20T05:04:00Z') },
    ]);
  });

  it('derives the missing rates from the USD rates of the same day', async () => {
    await migration.up(sequelize.getQueryInterface());

    const nzd = await rates('NZD');
    expect(Object.keys(nzd).sort()).to.deep.eq(['EUR', 'MRO', 'NZD', 'USD']);
    expect(nzd.USD).to.be.closeTo(1 / 1.7, 1e-9);
    expect(nzd.EUR).to.be.closeTo(0.9 / 1.7, 1e-9);
    expect(nzd.NZD).to.be.closeTo(1, 1e-9);

    const backfilled = await models.CurrencyExchangeRate.findOne({ where: { from: 'NZD', to: 'EUR' } });
    expect(backfilled.createdAt.toISOString()).to.eq(day.toISOString());

    expect(await rates('EUR')).to.deep.eq({ USD: 1.11 }); // recorded by the cron: untouched
    expect(await rates('MRO')).to.deep.eq({}); // no longer supported
  });

  it('can run again without duplicating rows', async () => {
    const count = await models.CurrencyExchangeRate.count();
    await migration.up(sequelize.getQueryInterface());
    expect(await models.CurrencyExchangeRate.count()).to.eq(count);
  });
});
