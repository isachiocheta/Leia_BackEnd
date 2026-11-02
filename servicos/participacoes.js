'use strict';

const { Transaction } = require('sequelize');
const { bloquearCiclo } = require('../database/bloqueio-ciclo');
const { ErroAplicacao, MENSAGENS_CAMPOS } = require('../utilitarios/erro-aplicacao');
const { exigirRecurso, comContextoPersistencia } = require('../utilitarios/persistencia');
const { lerOpcoesListagem } = require('../utilitarios/listagem');
const { conferirCicloLiberado, conferirLeitor } = require('./regras-leitura');

const repositorio = require('../repositorios/participacoes');

function participacaoPublica(linha) {
  const { genero, ...dados } = linha;
  return dados;
}

async function consultarMinhaParticipacao(cicloId, usuarioId, conexao, transaction) {
  return comContextoPersistencia('buscar', async () => participacaoPublica(exigirRecurso(
    await repositorio.participacaoPropria(cicloId, usuarioId, conexao, transaction),
  )));
}

async function aderirAoCiclo(cicloId, identidade, conexao, { agora = Date.now } = {}) {
  return comContextoPersistencia('criar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const ciclo = await bloquearCiclo(conexao, cicloId, transaction);
    await conferirLeitor(identidade, conexao, transaction);
    conferirCicloLiberado(ciclo, agora());
    // A unicidade do banco arbitra também pedidos simultâneos. Nunca recebe
    // usuário, página inicial ou conclusão do corpo da requisição.
    await conexao.models.ParticipacaoLeitura.create({ usuarioId: identidade.id, cicloId, paginaAtual: 0, concluidaEm: null }, {
      fields: ['usuarioId', 'cicloId', 'paginaAtual', 'concluidaEm'], transaction,
    });
    return consultarMinhaParticipacao(cicloId, identidade.id, conexao, transaction);
  }));
}

async function atualizarProgresso(cicloId, identidade, paginaAtual, conexao, { agora = Date.now } = {}) {
  if (!Number.isInteger(paginaAtual) || paginaAtual < 0 || paginaAtual > 2147483647) {
    throw new ErroAplicacao('VALIDATION_ERROR', { fields: [{ field: 'paginaAtual', message: MENSAGENS_CAMPOS.INVALID_VALUE }] });
  }
  return comContextoPersistencia('atualizar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const ciclo = await bloquearCiclo(conexao, cicloId, transaction);
    await conferirLeitor(identidade, conexao, transaction);
    const participacao = exigirRecurso(await conexao.models.ParticipacaoLeitura.findOne({
      where: { cicloId, usuarioId: identidade.id }, transaction, lock: transaction.LOCK.UPDATE,
    }));
    const instante = agora();
    conferirCicloLiberado(ciclo, instante);
    // O livro já foi bloqueado pelo protocolo do ciclo. A releitura usa esse
    // mesmo vínculo e transação; não adquire um livro novo depois do ciclo.
    const livro = exigirRecurso(await conexao.models.Livro.findByPk(ciclo.livroId, { attributes: ['id', 'totalPaginas'], transaction }));
    if (paginaAtual > livro.totalPaginas) throw new ErroAplicacao('VALIDATION_ERROR', {
      fields: [{ field: 'paginaAtual', message: MENSAGENS_CAMPOS.INVALID_VALUE }],
    });
    if (paginaAtual === livro.totalPaginas && participacao.paginaAtual === livro.totalPaginas) {
      // Repetição é leitura: preserva inclusive a precisão original do timestamp
      // no PostgreSQL, sem regravar uma data já existente pelo parser do Date.
      return consultarMinhaParticipacao(cicloId, identidade.id, conexao, transaction);
    }
    const concluidaEm = paginaAtual === livro.totalPaginas ? new Date(instante) : null;
    // Conclusão se baseia na página exata, jamais no percentual arredondado.
    await participacao.update({ paginaAtual, concluidaEm }, { fields: ['paginaAtual', 'concluidaEm'], transaction });
    return consultarMinhaParticipacao(cicloId, identidade.id, conexao, transaction);
  }));
}

async function listarMinhasParticipacoes(usuarioId, consulta, conexao) {
  const { page, pageSize, limit, offset } = lerOpcoesListagem(consulta, { id: 'id' });
  return comContextoPersistencia('buscar', async () => {
    const resultado = await repositorio.historicoLeituras(usuarioId, conexao, { limit, offset });
    return { data: resultado.data.map(participacaoPublica), meta: { page, pageSize, total: resultado.total } };
  });
}

async function listarParticipantes(cicloId, consulta, conexao) {
  const { page, pageSize, limit, offset } = lerOpcoesListagem(consulta, { id: 'id' });
  return comContextoPersistencia('buscar', async () => {
    exigirRecurso(await conexao.models.CicloLeitura.findByPk(cicloId, { attributes: ['id'] }));
    const resultado = await repositorio.participantesCiclo(cicloId, conexao, { limit, offset });
    const data = resultado.data.map(({ livro, ...dados }) => dados);
    return { data, meta: { page, pageSize, total: resultado.total } };
  });
}

module.exports = { aderirAoCiclo, consultarMinhaParticipacao, atualizarProgresso, listarMinhasParticipacoes, listarParticipantes };
