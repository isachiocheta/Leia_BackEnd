'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

module.exports = {
  async up(queryInterface, Sequelize) {
    // Manifesto técnico de autoria, fora do domínio. Não contém senhas/hashes,
    // progresso, indicadores ou cópias dos dados mutáveis das entidades.
    await queryInterface.createTable('cargas_demonstracao', {
      chave: { type: Sequelize.STRING(60), primaryKey: true, allowNull: false },
      data_base: { type: Sequelize.DATEONLY, allowNull: false },
      manifesto: { type: Sequelize.JSONB, allowNull: false },
      criado_em: { type: Sequelize.DATE, allowNull: false },
    });
  },
  async down(queryInterface) {
    validarDestinoTeste(queryInterface.sequelize);
    // Remove apenas o controle. Nunca apaga entidades nem referências reutilizadas.
    await queryInterface.dropTable('cargas_demonstracao');
  },
};
