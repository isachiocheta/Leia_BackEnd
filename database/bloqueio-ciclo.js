'use strict';

const { bloquearLivro } = require('./bloqueio-livro');
const { exigirRecurso } = require('../utilitarios/persistencia');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');

async function bloquearCiclo(conexao, id, transaction, novoLivroId) {
  if (!transaction) throw new TypeError('O bloqueio do ciclo exige uma transação.');
  const modelo = conexao.models.CicloLeitura;
  const referencia = exigirRecurso(await modelo.findByPk(id, { attributes: ['id', 'livroId'], transaction }));
  // Ordem global: livros por id crescente, depois ciclo. Escritores de encontros
  // e participações devem usar este protocolo antes de validar seus vínculos.
  const livros = [...new Set([referencia.livroId, novoLivroId].filter((valor) => valor !== undefined))].sort((a, b) => a - b);
  for (const livroId of livros) {
    try { await bloquearLivro(conexao, livroId, transaction); }
    catch (erro) {
      if (erro.codigo === 'NOT_FOUND' && livroId === novoLivroId && livroId !== referencia.livroId) {
        throw new ErroAplicacao('INVALID_REFERENCE');
      }
      throw erro;
    }
  }
  const ciclo = exigirRecurso(await modelo.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }));
  // Não adquira novos livros depois do ciclo: isso inverteria a ordem de locks.
  // Uma troca ocorrida durante a espera exige nova tentativa do chamador.
  if (ciclo.livroId !== referencia.livroId) throw new ErroAplicacao('CONFLICT');
  return ciclo;
}

module.exports = { bloquearCiclo };
