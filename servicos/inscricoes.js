'use strict';

const { QueryTypes, Transaction } = require('sequelize');
const { bloquearEncontro } = require('../database/bloqueio-encontro');
const { conferirCicloLiberado, conferirLeitor } = require('./regras-leitura');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');
const { comContextoPersistencia, exigirRecurso } = require('../utilitarios/persistencia');
const { lerOpcoesListagem } = require('../utilitarios/listagem');
const { dataEmSaoPaulo } = require('../utilitarios/datas-civis');

const repositorio = require('../repositorios/inscricoes');

async function conferirDisponibilidade(ciclo, encontro, usuarioId, instante, conexao, transaction) {
  conferirCicloLiberado(ciclo, instante);
  const dia = dataEmSaoPaulo(encontro.inicioEm);
  if (encontro.situacao !== 'AGENDADO' || encontro.inicioEm.getTime() <= instante || dia < ciclo.dataInicio || dia > ciclo.dataFim) {
    throw new ErroAplicacao('CONFLICT');
  }
  const participacao = await conexao.models.ParticipacaoLeitura.findOne({
    where: { usuarioId, cicloId: ciclo.id }, attributes: ['id'], transaction, lock: transaction.LOCK.SHARE,
  });
  if (!participacao) throw new ErroAplicacao('FORBIDDEN');
}

async function consultarInscricao(encontroId, usuarioId, conexao, transaction) {
  return exigirRecurso(await repositorio.inscricaoPropria(encontroId, usuarioId, conexao, transaction));
}

async function inscreverNoEncontro(encontroId, identidade, conexao, { agora = Date.now } = {}) {
  return comContextoPersistencia('criar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const { encontro, ciclo } = await bloquearEncontro(conexao, encontroId, transaction);
    await conferirLeitor(identidade, conexao, transaction);
    await conferirDisponibilidade(ciclo, encontro, identidade.id, agora(), conexao, transaction);
    // Apenas o usuário da sessão. UNIQUE(usuario_id, encontro_id) continua sendo
    // a autoridade da duplicidade, inclusive para solicitações simultâneas.
    await conexao.models.InscricaoEncontro.create({ usuarioId: identidade.id, encontroId }, {
      fields: ['usuarioId', 'encontroId'], transaction,
    });
    return consultarInscricao(encontroId, identidade.id, conexao, transaction);
  }));
}

async function cancelarMinhaInscricao(encontroId, identidade, conexao, { agora = Date.now } = {}) {
  return comContextoPersistencia('excluir', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const { encontro, ciclo } = await bloquearEncontro(conexao, encontroId, transaction);
    await conferirLeitor(identidade, conexao, transaction);
    const where = { usuarioId: identidade.id, encontroId };
    // Ausência própria é 404 mesmo em um evento cujo prazo já terminou.
    exigirRecurso(await conexao.models.InscricaoEncontro.findOne({ where, attributes: ['id'], transaction }));
    await conferirDisponibilidade(ciclo, encontro, identidade.id, agora(), conexao, transaction);
    // Mantém a ordem pais -> usuário -> participação -> inscrição, e relê a
    // titularidade sob lock antes da exclusão. Os pais seguem bloqueados.
    const inscricao = exigirRecurso(await conexao.models.InscricaoEncontro.findOne({ where, transaction, lock: transaction.LOCK.UPDATE }));
    await inscricao.destroy({ transaction });
  }));
}

async function listarMinhasInscricoes(usuarioId, consulta, conexao, { agora = Date.now } = {}) {
  const { futuros, ...paginacao } = consulta;
  if (futuros !== undefined && !['true', 'false'].includes(futuros)) throw new ErroAplicacao('VALIDATION_ERROR');
  const { page, pageSize, limit, offset } = lerOpcoesListagem(paginacao, { id: 'id' });
  return comContextoPersistencia('buscar', async () => {
    const resultado = await repositorio.agendaLeitor(usuarioId, conexao, { futuros: futuros === 'true', agora: agora(), limit, offset });
    return { data: resultado.data, meta: { page, pageSize, total: resultado.total } };
  });
}

async function listarInscritos(encontroId, consulta, conexao) {
  const { page, pageSize, limit, offset } = lerOpcoesListagem(consulta, { id: 'id' });
  return comContextoPersistencia('buscar', async () => {
    exigirRecurso(await conexao.models.Encontro.findByPk(encontroId, { attributes: ['id'] }));
    const [data, totais] = await Promise.all([
      conexao.query(`SELECT i.id, i.encontro_id AS "encontroId", i.criado_em AS "criadoEm",
        json_build_object('id', u.id, 'nome', u.nome) AS usuario FROM inscricoes_encontro i
        JOIN usuarios u ON u.id = i.usuario_id WHERE i.encontro_id = $encontro ORDER BY i.id ASC LIMIT $limite OFFSET $deslocamento`, {
        type: QueryTypes.SELECT, bind: { encontro: encontroId, limite: limit, deslocamento: offset },
      }),
      conexao.query('SELECT count(*) AS total FROM inscricoes_encontro WHERE encontro_id = $encontro', { type: QueryTypes.SELECT, bind: { encontro: encontroId } }),
    ]);
    return { data, meta: { page, pageSize, total: Number(totais[0].total) } };
  });
}

module.exports = { inscreverNoEncontro, cancelarMinhaInscricao, listarMinhasInscricoes, listarInscritos };
