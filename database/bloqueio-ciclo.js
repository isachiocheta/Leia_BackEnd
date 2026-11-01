'use strict';

const { bloquearLivro } = require('./bloqueio-livro');
const { exigirRecurso } = require('../utilitarios/persistencia');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');

async function bloquearGrupo(conexao, ids, transaction, novoLivroId) {
  if (!transaction) throw new TypeError('O bloqueio do ciclo exige uma transação.');
  const modelo = conexao.models.CicloLeitura;
  const referencias = new Map();
  const ordenados = [...new Set(ids)].sort((a, b) => a - b);
  for (const id of ordenados) referencias.set(id, exigirRecurso(await modelo.findByPk(id, { attributes: ['id', 'livroId'], transaction })));
  // Ordem global: livros por id crescente, depois ciclo. Escritores de encontros
  // e participações devem usar este protocolo antes de validar seus vínculos.
  const livros = [...new Set([...referencias.values()].map((ciclo) => ciclo.livroId).concat(novoLivroId).filter((valor) => valor !== undefined))].sort((a, b) => a - b);
  for (const livroId of livros) {
    try { await bloquearLivro(conexao, livroId, transaction); }
    catch (erro) {
      if (erro.codigo === 'NOT_FOUND' && livroId === novoLivroId && ![...referencias.values()].some((ciclo) => ciclo.livroId === livroId)) {
        throw new ErroAplicacao('INVALID_REFERENCE');
      }
      throw erro;
    }
  }
  const ciclos = new Map();
  for (const id of ordenados) {
    const ciclo = exigirRecurso(await modelo.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }));
    // Não adquira novos livros depois dos ciclos: isso inverteria a ordem.
    if (ciclo.livroId !== referencias.get(id).livroId) throw new ErroAplicacao('CONFLICT');
    ciclos.set(id, ciclo);
  }
  return ciclos;
}

async function bloquearCiclo(conexao, id, transaction, novoLivroId) {
  return (await bloquearGrupo(conexao, [id], transaction, novoLivroId)).get(id);
}

async function bloquearCiclos(conexao, ids, transaction) {
  return bloquearGrupo(conexao, ids, transaction);
}

module.exports = { bloquearCiclo, bloquearCiclos };
