'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };

      // Sem default ou credenciais fictícias. Se houver usuários legados sem hash,
      // o PostgreSQL rejeita a adição NOT NULL e reverte toda esta migration.
      await queryInterface.addColumn('usuarios', 'senha_hash', {
        type: Sequelize.TEXT,
        allowNull: false,
      }, opcoes);
      await queryInterface.addColumn('usuarios', 'situacao', {
        type: Sequelize.STRING(10),
        allowNull: false,
        defaultValue: 'PENDENTE',
      }, opcoes);
      await queryInterface.addColumn('usuarios', 'session_version', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      }, opcoes);
      await queryInterface.changeColumn('usuarios', 'nome', {
        type: Sequelize.STRING(100),
        allowNull: false,
      }, opcoes);

      // id, timestamps, unicidade de email e CHECK/default de perfil já são
      // definidos na migration anterior, preservada como foi aplicada.
      for (const [nome, campos, expressao] of [
        ['usuarios_nome_nao_vazio', ['nome'], '"nome" ~ \'[^[:space:]]\''],
        ['usuarios_email_normalizado', ['email'], '"email" = lower(btrim("email")) AND length(btrim("email")) > 0'],
        ['usuarios_senha_hash_nao_vazio', ['senha_hash'], 'length(btrim("senha_hash")) > 0'],
        ['usuarios_situacao_valida', ['situacao'], '"situacao" IN (\'PENDENTE\', \'ATIVO\', \'INATIVO\')'],
        ['usuarios_session_version_nao_negativa', ['session_version'], '"session_version" >= 0'],
      ]) {
        await queryInterface.addConstraint('usuarios', {
          fields: campos,
          type: 'check',
          name: nome,
          where: Sequelize.literal(expressao),
          transaction,
        });
      }
    });
  },

  async down(queryInterface, Sequelize) {
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };

      for (const nome of [
        'usuarios_session_version_nao_negativa', 'usuarios_situacao_valida',
        'usuarios_senha_hash_nao_vazio', 'usuarios_email_normalizado', 'usuarios_nome_nao_vazio',
      ]) {
        await queryInterface.removeConstraint('usuarios', nome, opcoes);
      }

      await queryInterface.changeColumn('usuarios', 'nome', {
        type: Sequelize.STRING(120),
        allowNull: false,
      }, opcoes);
      // Rollback restaura o schema anterior; os dados destas colunas são perdidos.
      await queryInterface.removeColumn('usuarios', 'session_version', opcoes);
      await queryInterface.removeColumn('usuarios', 'situacao', opcoes);
      await queryInterface.removeColumn('usuarios', 'senha_hash', opcoes);
    });
  },
};
