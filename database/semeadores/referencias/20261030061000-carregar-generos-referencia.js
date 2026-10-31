'use strict';

const { validarDestinoTeste } = require('../../../configuracao/operacoes-banco');

const semeador = '20261030061000-carregar-generos-referencia.js';
const nomes = Object.freeze([
  'Aventura', 'Conto', 'Fábula', 'Ficção científica', 'Poesia', 'Romance',
]);

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const valores = nomes.map((nome, indice) => `($${indice + 2}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).join(', ');

      // A carga padrão contém somente referências, sem usuários, livros ou
      // demonstrações. RETURNING registra a autoria apenas das novas linhas:
      // gêneros preexistentes reutilizados nunca passam a pertencer ao seeder.
      await queryInterface.sequelize.query(`
        WITH inseridos AS (
          INSERT INTO "generos" ("nome", "criado_em", "atualizado_em")
          VALUES ${valores}
          ON CONFLICT ("nome") DO NOTHING
          RETURNING "id"
        )
        INSERT INTO "generos_semeados" ("semeador", "genero_id")
        SELECT $1, "id" FROM inseridos
        ON CONFLICT ("semeador", "genero_id") DO NOTHING
      `, { bind: [semeador, ...nomes], transaction });
    });
  },

  async down(queryInterface) {
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      // Não removemos por nome: só IDs comprovadamente inseridos nesta carga.
      // O CASCADE técnico limpa a proveniência; a FK RESTRICT dos livros faz
      // toda a transação falhar se alguma referência criada estiver em uso.
      await queryInterface.sequelize.query(`
        DELETE FROM "generos" AS genero
        USING "generos_semeados" AS origem
        WHERE origem."semeador" = $1
          AND origem."genero_id" = genero."id"
      `, { bind: [semeador], transaction });
    });
  },
};
