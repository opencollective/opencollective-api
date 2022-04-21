// // eslint-disable-next-line node/no-unpublished-import
// import Benchmark from 'benchmark';
// import { times } from 'lodash';

// import { randUrl } from '../../test/stores';
// import { fakeCollective, randStr } from '../../test/test-helpers/fake-data';
// import { resetTestDB } from '../../test/utils';
// import { searchCollectivesInDB } from '../lib/search';
// import models from '../models';

// const searchSuite = new Benchmark.Suite();

// const bulkFakeCollective = (number, collectiveData = {}) => {
//   return models.Collective.bulkCreate(
//     times(number, () => {
//       return {
//         type: 'COLLECTIVE',
//         name: randStr('Test Collective '),
//         slug: randStr('collective-'),
//         description: randStr('Description '),
//         currency: 'USD',
//         twitterHandle: randStr('twitter'),
//         website: randUrl(),
//         hostFeePercent: 10,
//         tags: [randStr(), randStr()],
//         isActive: true,
//         ...collectiveData,
//       };
//     }),
//     {
//       validate: false,
//       hooks: false,
//     },
//   );
// };

// const prepareDB = async () => {
//   await resetTestDB();
//   await bulkFakeCollective(10000);
//   await bulkFakeCollective(100, { tags: ['open source'] });
//   await fakeCollective({ name: 'Babel' });
// };

// const runTests = async () => {
//   // Seed database
//   console.log('Prepare DB');
//   await prepareDB();
//   console.log('DB ready!');

//   searchSuite
//     .add('search by name', {
//       defer: true,
//       async fn(deferred) {
//         console.log('RUN');
//         const results = await searchCollectivesInDB('Babel');
//         if (results.length !== 1) {
//           console.log('NOOOO', results);
//           throw new Error('Wrong number of results');
//         }

//         console.log('None');
//         deferred.resolve();
//       },
//     })
//     .on('cycle', event => {
//       // Output benchmark result by converting benchmark result to string
//       console.log(String(event.target));
//     })
//     .run();
// };

// runTests();
