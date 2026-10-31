'use strict';

const bcrypt = require('bcrypt');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');
const { comContextoPersistencia, exigirRecurso } = require('../utilitarios/persistencia');
const { lerOpcoesListagem } = require('../utilitarios/listagem');

const ATRIBUTOS_PUBLICOS = Object.freeze(['id', 'nome', 'email', 'perfil', 'situacao']);
const SITUACOES = Object.freeze(['PENDENTE', 'ATIVO', 'INATIVO']);
const ORDENACAO = Object.freeze({ id: 'id', nome: 'nome', email: 'email', situacao: 'situacao', criadoEm: 'criado_em' });
const TRANSICOES = Object.freeze({
  PENDENTE: Object.freeze(['ATIVO', 'INATIVO']),
  ATIVO: Object.freeze(['INATIVO']),
  INATIVO: Object.freeze(['ATIVO']),
});

function usuarioPublico(usuario) {
  return Object.fromEntries(ATRIBUTOS_PUBLICOS.map((campo) => [campo, usuario[campo]]));
}

async function cadastrarLeitor(dados, Usuario) {
  // A criação nunca recebe atributos arbitrários do chamador. O banco é a
  // autoridade da unicidade, inclusive entre cadastros simultâneos.
  return comContextoPersistencia('criar', async () => {
    const senhaHash = await bcrypt.hash(dados.senha, 12);
    const usuario = await Usuario.create({
      nome: dados.nome, email: dados.email, senhaHash,
      perfil: 'LEITOR', situacao: 'PENDENTE', sessionVersion: 0,
    }, { fields: ['nome', 'email', 'senhaHash', 'perfil', 'situacao', 'sessionVersion'] });
    return usuarioPublico(usuario);
  });
}

async function listarLeitores(consulta, Usuario) {
  const { situacao, ...paginacao } = consulta;
  if (situacao !== undefined && !SITUACOES.includes(situacao)) throw new ErroAplicacao('VALIDATION_ERROR');
  const { page, pageSize, limit, offset, order } = lerOpcoesListagem(paginacao, ORDENACAO);
  const where = { perfil: 'LEITOR' };
  if (situacao !== undefined) where.situacao = situacao;
  return comContextoPersistencia('buscar', async () => {
    const { rows, count } = await Usuario.findAndCountAll({
      attributes: [...ATRIBUTOS_PUBLICOS], where, limit, offset, order,
    });
    return { data: rows.map(usuarioPublico), meta: { page, pageSize, total: count } };
  });
}

async function alterarSituacaoLeitor(id, situacao, Usuario) {
  if (!SITUACOES.includes(situacao)) throw new ErroAplicacao('VALIDATION_ERROR');
  return comContextoPersistencia('atualizar', () => Usuario.sequelize.transaction(async (transaction) => {
    // O bloqueio serializa mudanças concorrentes na mesma conta. Situação e
    // versão são gravadas juntas; nenhum vínculo ou registro histórico é apagado.
    const usuario = exigirRecurso(await Usuario.findOne({
      where: { id, perfil: 'LEITOR' },
      attributes: [...ATRIBUTOS_PUBLICOS, 'sessionVersion'],
      transaction, lock: transaction.LOCK.UPDATE,
    }));
    if (usuario.situacao === situacao) return usuarioPublico(usuario);
    // Aprovar/recusar pendente, desativar ativo e reativar inativo. Contas já
    // decididas não retornam à fila de aprovação por esta operação.
    if (!TRANSICOES[usuario.situacao]?.includes(situacao) || usuario.sessionVersion >= 2147483647) {
      throw new ErroAplicacao('CONFLICT');
    }
    await usuario.update({ situacao, sessionVersion: usuario.sessionVersion + 1 }, {
      fields: ['situacao', 'sessionVersion'], transaction,
    });
    return usuarioPublico(usuario);
  }));
}

module.exports = { cadastrarLeitor, listarLeitores, alterarSituacaoLeitor, usuarioPublico, SITUACOES };
