'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Contrato técnico do seederStorage do sequelize-cli, separado do domínio.
      await queryInterface.createTable('sequelize_seeds', {
        name: { type: Sequelize.STRING(255), allowNull: false, primaryKey: true },
      }, { transaction });
      // Proveniência apenas dos gêneros realmente inseridos por cada seeder.
      // A exclusão de um gênero sem uso limpa somente essa metadata técnica.
      await queryInterface.createTable('generos_semeados', {
        semeador: { type: Sequelize.STRING(255), allowNull: false, primaryKey: true },
        genero_id: {
          type: Sequelize.INTEGER, allowNull: false, primaryKey: true,
          references: { model: 'generos', key: 'id' },
          onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
      }, { transaction });
    });
  },

  async down(queryInterface) {
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      // Reverter o controle não apaga referências nem outras entidades do clube.
      await queryInterface.dropTable('generos_semeados', { transaction });
      await queryInterface.dropTable('sequelize_seeds', { transaction });
    });
  },
};
