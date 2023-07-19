'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
    UPDATE "ConnectedAccounts"
    SET
      "token" = 'U2FsdGVkX18GcPlee5l0n2bNYvxG01S2taAZvleSaQXnBRRaFd4GrfdaPGyQJ4cHorpq9aJJ1YkU0ygZjtPqXvf9onBMSRGoRcoMCx1Mg0sQNtoaD7Zs7UiOlxHU6MtZ+QOWSxyz+aPnvX0u9RBDmSRU1Q/ziOLqYhnmW9U9hdk='
    WHERE "id" = 2131 and "CollectiveId" = 9805 and service = 'stripe';
  `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
    UPDATE "ConnectedAccounts"
    SET
      "token" = 'U2FsdGVkX1+s78rEBZzsfGPPyu3gcmdjLEZ1cPmOx9CIcDYuTLYZ0nUr5T5M4tuUakCZ2eXMoBOpKuTV7v0YYlmcPYv8FZEG4WwCUdauXQUy8CC6CjZRtVLlF1YVnlZDgADxlW69cHdTIE4sAKLPszQy0J7ptDOXfZdX9mQtLhM='
    WHERE "id" = 2131 and "CollectiveId" = 9805 and service = 'stripe';
  `);
  },
};
