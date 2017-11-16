const Liana = require('forest-express-sequelize');

Liana.collection('User', {
  actions: [{
    name: 'Merge user',
    fields: [{
      field: 'Collective',
      type: 'String',
      reference: 'Collective.id'
    }]
  }]
});
