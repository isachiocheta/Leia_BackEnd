'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };

      // Sem número fictício de páginas. Livros legados sem esse dado fazem esta
      // migration falhar atomicamente, preservando os valores e o schema anterior.
      await queryInterface.addColumn('livros', 'total_paginas', {
        type: Sequelize.INTEGER,
        allowNull: false,
      }, opcoes);
      await queryInterface.addColumn('livros', 'ano_publicacao', {
        type: Sequelize.INTEGER,
        allowNull: true,
      }, opcoes);
      await queryInterface.addColumn('livros', 'descricao', {
        type: Sequelize.STRING(2000),
        allowNull: true,
      }, opcoes);
      await queryInterface.addColumn('livros', 'capa_url', {
        type: Sequelize.TEXT,
        allowNull: true,
      }, opcoes);
      await queryInterface.renameColumn('livros', 'autor_informado', 'autor', opcoes);
      await queryInterface.changeColumn('livros', 'autor', {
        type: Sequelize.STRING(120),
        allowNull: false,
      }, opcoes);
      await queryInterface.changeColumn('livros', 'titulo', {
        type: Sequelize.STRING(160),
        allowNull: false,
      }, opcoes);

      for (const [nome, campo, expressao] of [
        ['livros_titulo_nao_vazio', 'titulo', '"titulo" ~ \'[^[:space:]]\''],
        ['livros_autor_nao_vazio', 'autor', '"autor" ~ \'[^[:space:]]\''],
        ['livros_total_paginas_positivo', 'total_paginas', '"total_paginas" > 0'],
        ['livros_ano_publicacao_positivo', 'ano_publicacao', '"ano_publicacao" IS NULL OR "ano_publicacao" > 0'],
      ]) {
        await queryInterface.addConstraint('livros', {
          fields: [campo], type: 'check', name: nome,
          where: Sequelize.literal(expressao), transaction,
        });
      }

      // A FK genero_id da migration original permanece NOT NULL e RESTRICT.
      // O livro é a obra cadastrada; ciclos continuam referenciando seu id.
      // O limite superior de ano será uma regra do serviço, não do schema.
    });
  },

  async down(queryInterface, Sequelize) {
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };
      for (const nome of [
        'livros_ano_publicacao_positivo', 'livros_total_paginas_positivo',
        'livros_autor_nao_vazio', 'livros_titulo_nao_vazio',
      ]) {
        await queryInterface.removeConstraint('livros', nome, opcoes);
      }
      await queryInterface.changeColumn('livros', 'titulo', {
        type: Sequelize.STRING(200), allowNull: false,
      }, opcoes);
      await queryInterface.changeColumn('livros', 'autor', {
        type: Sequelize.STRING(200), allowNull: false,
      }, opcoes);
      await queryInterface.renameColumn('livros', 'autor', 'autor_informado', opcoes);

      // Reversão estrutural: os valores dos novos campos são descartados.
      for (const coluna of ['capa_url', 'descricao', 'ano_publicacao', 'total_paginas']) {
        await queryInterface.removeColumn('livros', coluna, opcoes);
      }
      // A FK e as referências de ciclos são preservadas; reverter livros antes
      // da migration de gêneros mantém a ordem inversa de aplicação.
    });
  },
};
