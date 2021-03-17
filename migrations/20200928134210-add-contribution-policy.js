'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface
      .addColumn('Collectives', 'contributionPolicy', {
        type: Sequelize.TEXT,
      })
      .then(() =>
        queryInterface.addColumn('CollectiveHistories', 'contributionPolicy', {
          type: Sequelize.TEXT,
        }),
      )
      .then(() => {
        console.log('>>> done');
      });
  },

  down: function (queryInterface) {
    return queryInterface
      .removeColumn('Collectives', 'contributionPolicy')
      .then(() => queryInterface.removeColumn('CollectiveHistories', 'contributionPolicy'));
  },
};
