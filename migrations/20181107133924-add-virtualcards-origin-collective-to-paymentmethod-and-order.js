'use strict';

module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface
      .addColumn('PaymentMethods', 'CreatedByCollectiveId', {
        type: Sequelize.INTEGER,
        references: { model: 'Collectives', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
        description:
          'References the collective that created this payment method',
      })
      .then(() =>
        queryInterface.addColumn('Orders', 'UsingVirtualCardFromCollectiveId', {
          type: Sequelize.INTEGER,
          references: { model: 'Collectives', key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
          allowNull: true,
          description:
            'References the collective that created the virtual card used for this order',
        }),
      );
  },

  down: queryInterface => {
    return queryInterface
      .removeColumn('PaymentMethods', 'CreatedByCollectiveId')
      .then(() =>
        queryInterface.removeColumn(
          'Orders',
          'UsingVirtualCardFromCollectiveId',
        ),
      );
  },
};
