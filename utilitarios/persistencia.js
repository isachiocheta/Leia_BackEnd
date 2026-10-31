'use strict';

const {
  ConnectionError, EmptyResultError, ExclusionConstraintError, ForeignKeyConstraintError,
  OptimisticLockError, TimeoutError, UniqueConstraintError, ValidationError, DatabaseError,
} = require('sequelize');
const { ErroAplicacao, MENSAGENS_CAMPOS } = require('./erro-aplicacao');

function exigirRecurso(recurso) {
  if (recurso === null || recurso === undefined) throw new ErroAplicacao('NOT_FOUND');
  return recurso;
}

function traduzirErroPersistencia(erro, operacao) {
  if (erro instanceof ErroAplicacao) return erro;
  if (erro instanceof EmptyResultError) return new ErroAplicacao('NOT_FOUND');
  if (erro instanceof UniqueConstraintError) return new ErroAplicacao('DUPLICATE_RESOURCE');
  if (erro instanceof ForeignKeyConstraintError) {
    return new ErroAplicacao(erro.reltype === 'parent' || operacao === 'excluir'
      ? 'RESOURCE_IN_USE'
      : 'INVALID_REFERENCE');
  }
  if (erro instanceof ValidationError) {
    return new ErroAplicacao('VALIDATION_ERROR', {
      fields: erro.errors?.map((item) => ({
        field: item.path,
        message: item.validatorKey === 'is_null' || item.type === 'notNull Violation'
          ? MENSAGENS_CAMPOS.REQUIRED
          : MENSAGENS_CAMPOS.INVALID_VALUE,
      })),
    });
  }
  if (erro instanceof ConnectionError || erro instanceof TimeoutError) {
    return new ErroAplicacao('SERVICE_UNAVAILABLE');
  }
  if (erro instanceof ExclusionConstraintError || erro instanceof OptimisticLockError) {
    return new ErroAplicacao('CONFLICT');
  }
  if (erro instanceof DatabaseError) {
    // SQLSTATE é uma classificação do PostgreSQL; SQL e mensagens do driver
    // nunca são interpretados nem incluídos no contrato público.
    const codigo = erro.parent?.code;
    if (['23502', '23514', '22001', '22003', '22007', '22008', '22P02'].includes(codigo)) {
      return new ErroAplicacao('VALIDATION_ERROR');
    }
    if (['40001', '40P01'].includes(codigo)) return new ErroAplicacao('CONFLICT');
    if (['53300', '57014', '57P01', '57P02', '57P03'].includes(codigo) || /^08[0-9A-Z]{3}$/.test(codigo || '')) {
      return new ErroAplicacao('SERVICE_UNAVAILABLE');
    }
  }
  return erro;
}

async function comContextoPersistencia(operacao, tarefa) {
  if (!['buscar', 'criar', 'atualizar', 'excluir'].includes(operacao) || typeof tarefa !== 'function') {
    throw new TypeError('Informe uma operação de persistência válida e sua função.');
  }

  try {
    return await tarefa();
  } catch (erro) {
    // O Sequelize 6/PostgreSQL não informa reltype nas violações de FK.
    // O emissor passa a operação interna para distinguir dependência de uma
    // exclusão (409) de referência inválida ao criar/atualizar (422), sem ler SQL.
    throw traduzirErroPersistencia(erro, operacao);
  }
}

module.exports = { exigirRecurso, comContextoPersistencia, traduzirErroPersistencia };
