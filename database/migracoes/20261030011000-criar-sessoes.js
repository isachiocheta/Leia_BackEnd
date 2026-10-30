'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Contrato connect-pg-simple com tableName: 'sessoes'. Sem timestamps do ORM
      // ou colunas de outro armazenamento. DATE do Sequelize usaria fuso no PG.
      await queryInterface.sequelize.query(`
        CREATE TABLE "sessoes" (
          "sid" VARCHAR NOT NULL PRIMARY KEY,
          "sess" JSON NOT NULL,
          "expire" TIMESTAMP(6) WITHOUT TIME ZONE NOT NULL
        )
      `, { transaction });
      await queryInterface.addIndex('sessoes', ['expire'], {
        name: 'sessoes_expire_indice',
        transaction,
      });
    });
  },

  async down(queryInterface) {
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('sessoes', { transaction });
    });
  },
};
