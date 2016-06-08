'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.addColumn('Groups', 'tags', {
      type: Sequelize.ARRAY(Sequelize.STRING)
    })
    .then(() => queryInterface.addColumn('Groups', 'supercollective', {
      type: Sequelize.BOOLEAN,
      defaultValue: false
    }))
  },

  down: function (queryInterface) {
    return queryInterface.removeColumn('Groups', 'supercollective')
      .then(() => queryInterface.removeColumn('Groups', 'tags'));
  }
};
