import { expect } from 'chai';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20261119120000-fix-incognito-slugs-of-named-profiles'; // eslint-disable-line import/default
import { CollectiveType } from '../../server/constants/collectives';
import models, { sequelize } from '../../server/models';
import { fakeCollective, fakeUser } from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

describe('migrations/20261119120000-fix-incognito-slugs-of-named-profiles', () => {
  before(async () => {
    await migration.down(sequelize.getQueryInterface());
    await resetTestDB();
  });

  after(async () => migration.down(sequelize.getQueryInterface()));

  /** A profile as `/users/signup` leaves it once the user set their name: named, with an `incognito-…` slug */
  const fakeProfile = async (name: string, slugSuffix: string, values: Record<string, unknown> = {}) => {
    const user = await fakeUser();
    await sequelize.query(`UPDATE "Collectives" SET name = :name, slug = :slug WHERE id = :id`, {
      replacements: { id: user.CollectiveId, name, slug: `incognito-${slugSuffix}` },
    });
    if (Object.keys(values).length) {
      await models.Collective.update(values, { where: { id: user.CollectiveId }, hooks: false, validate: false });
    }
    return user.CollectiveId;
  };

  const getSlug = async (id: number) => (await models.Collective.findByPk(id, { paranoid: false })).slug;

  it('derives the slug from the name, and restores it on down', async () => {
    const named = await fakeProfile('Jane Migrationtest', 'aaaa1111');
    const sameNameA = await fakeProfile('Sam Duplicate', 'bbbb2222');
    const sameNameB = await fakeProfile('Sam Duplicate', 'cccc3333');
    const takenName = await fakeProfile('Taken Slugname', 'dddd4444');
    await fakeCollective({ slug: 'taken-slugname' });
    const takenByDeleted = await fakeProfile('Deleted Slugname', 'eeee5555');
    await fakeCollective({ slug: 'deleted-slugname', deletedAt: new Date() });

    // Left alone
    const placeholderName = await fakeProfile('incognito', 'ffff6666');
    const guestName = await fakeProfile('Guest', 'gggg7777');
    const reservedName = await fakeProfile('Dashboard', 'hhhh8888');
    const unusableName = await fakeProfile('***', 'iiii9999');
    const realIncognito = await fakeProfile('Not Really Hidden', 'jjjj0000', { isIncognito: true });
    const deleted = await fakeProfile('Deleted Person', 'kkkk1111', { deletedAt: new Date() });
    const organization = await fakeCollective({ type: CollectiveType.ORGANIZATION, name: 'Some Org' });
    await sequelize.query(`UPDATE "Collectives" SET slug = 'incognito-llll2222' WHERE id = :id`, {
      replacements: { id: organization.id },
    });
    const regularUser = await fakeUser(null, { name: 'Regular Person', slug: 'regular-person-slug' });

    await migration.up(sequelize.getQueryInterface());

    expect(await getSlug(named)).to.eq('jane-migrationtest');
    const duplicateSlugs = [await getSlug(sameNameA), await getSlug(sameNameB)];
    expect(duplicateSlugs).to.include('sam-duplicate');
    expect(duplicateSlugs.find(slug => slug !== 'sam-duplicate')).to.match(/^sam-duplicate-[0-9a-f]{8}$/);
    expect(await getSlug(takenName)).to.match(/^taken-slugname-[0-9a-f]{8}$/);
    expect(await getSlug(takenByDeleted)).to.match(/^deleted-slugname-[0-9a-f]{8}$/);

    expect(await getSlug(placeholderName)).to.eq('incognito-ffff6666');
    expect(await getSlug(guestName)).to.eq('incognito-gggg7777');
    expect(await getSlug(reservedName)).to.eq('incognito-hhhh8888');
    expect(await getSlug(unusableName)).to.eq('incognito-iiii9999');
    expect(await getSlug(realIncognito)).to.eq('incognito-jjjj0000');
    expect(await getSlug(deleted)).to.eq('incognito-kkkk1111');
    expect(await getSlug(organization.id)).to.eq('incognito-llll2222');
    expect(await getSlug(regularUser.CollectiveId)).to.eq('regular-person-slug');

    // A slug changed after the migration is not restored
    await sequelize.query(`UPDATE "Collectives" SET slug = 'sam-picked-this' WHERE id = :id`, {
      replacements: { id: sameNameA },
    });

    await migration.down(sequelize.getQueryInterface());

    expect(await getSlug(named)).to.eq('incognito-aaaa1111');
    expect(await getSlug(sameNameA)).to.eq('sam-picked-this');
    expect(await getSlug(sameNameB)).to.eq('incognito-cccc3333');
    expect(await getSlug(takenName)).to.eq('incognito-dddd4444');
    expect(await getSlug(takenByDeleted)).to.eq('incognito-eeee5555');
  });
});
