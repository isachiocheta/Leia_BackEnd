'use strict';

const { bloquearCiclos } = require('./bloqueio-ciclo');
const { exigirRecurso } = require('../utilitarios/persistencia');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');

async function bloquearEncontro(conexao, id, transaction, novoCicloId) {
  if (!transaction) throw new TypeError('O bloqueio do encontro exige uma transação.');
  const modelo = conexao.models.Encontro;
  const referencia = exigirRecurso(await modelo.findByPk(id, { attributes: ['id', 'cicloId'], transaction }));
  let ciclos;
  try {
    ciclos = await bloquearCiclos(conexao, [referencia.cicloId, novoCicloId ?? referencia.cicloId], transaction);
  } catch (erro) {
    if (erro.codigo === 'NOT_FOUND' && novoCicloId !== undefined && novoCicloId !== referencia.cicloId) throw new ErroAplicacao('INVALID_REFERENCE');
    throw erro;
  }
  // Protocolo também das inscrições: todos os livros em ordem, depois todos
  // os ciclos em ordem e por fim o encontro. A FK de inscrição toma KEY SHARE
  // neste encontro, que conflita com este FOR UPDATE e com a exclusão física.
  const encontro = exigirRecurso(await modelo.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }));
  if (encontro.cicloId !== referencia.cicloId) throw new ErroAplicacao('CONFLICT');
  return { encontro, ciclo: ciclos.get(encontro.cicloId), destino: ciclos.get(novoCicloId ?? encontro.cicloId) };
}

module.exports = { bloquearEncontro };
