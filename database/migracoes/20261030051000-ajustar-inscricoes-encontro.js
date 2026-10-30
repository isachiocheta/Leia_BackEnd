'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

const nomeConstraint = 'inscricoes_encontro_encontro_id_fkey';

async function substituirChave(queryInterface, onDelete, transaction) {
  await queryInterface.removeConstraint('inscricoes_encontro', nomeConstraint, { transaction });
  await queryInterface.addConstraint('inscricoes_encontro', {
    fields: ['encontro_id'], type: 'foreign key', name: nomeConstraint,
    references: { table: 'encontros', field: 'id' },
    onDelete, onUpdate: 'CASCADE', transaction,
  });
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Só a exclusão do encontro remove suas inscrições. A FK de usuário
      // permanece RESTRICT; PK, timestamps e UNIQUE(usuario_id, encontro_id)
      // da migration original permanecem intactos, sem duplicar constraints.
      await substituirChave(queryInterface, 'CASCADE', transaction);
      // Inscrição é intenção de comparecer, não presença. A elegibilidade e a
      // participação no mesmo ciclo serão verificadas pelos serviços.
    });
  },

  async down(queryInterface) {
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      await substituirChave(queryInterface, 'RESTRICT', transaction);
    });
  },
};
