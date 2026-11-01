'use strict';

const { exigirRecurso } = require('../utilitarios/persistencia');

async function bloquearLivro(conexao, id, transaction) {
  if (!transaction) throw new TypeError('O bloqueio do livro exige uma transação.');
  // Protocolo compartilhado: criar ou trocar o livro de um ciclo deve adquirir
  // este mesmo FOR UPDATE antes de validar e inserir, na mesma transação.
  // O lock forte também conflita com o KEY SHARE usado pela FK do PostgreSQL.
  return exigirRecurso(await conexao.models.Livro.findByPk(id, {
    transaction, lock: transaction.LOCK.UPDATE,
  }));
}

module.exports = { bloquearLivro };
