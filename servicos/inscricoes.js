'use strict';

const { QueryTypes, Transaction } = require('sequelize');
const { bloquearEncontro } = require('../database/bloqueio-encontro');
const { conferirCicloLiberado, conferirLeitor } = require('./regras-leitura');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');
const { comContextoPersistencia, exigirRecurso } = require('../utilitarios/persistencia');
const { lerOpcoesListagem } = require('../utilitarios/listagem');
const { dataEmSaoPaulo } = require('../utilitarios/datas-civis');

const CONSULTA = `SELECT i.id, i.encontro_id AS "encontroId", i.criado_em AS "criadoEm", i.atualizado_em AS "atualizadoEm",
  e.inicio_em AS "inicioEm", json_build_object('id', e.id, 'titulo', e.titulo, 'local', e.local, 'situacao', e.situacao) AS encontro,
  json_build_object('id', c.id, 'nome', c.nome, 'situacao', c.situacao, 'dataInicio', c.data_inicio::text, 'dataFim', c.data_fim::text) AS ciclo,
  json_build_object('id', l.id, 'titulo', l.titulo, 'autor', l.autor) AS livro
  FROM inscricoes_encontro i JOIN encontros e ON e.id = i.encontro_id
  JOIN ciclos_leitura c ON c.id = e.ciclo_id JOIN livros l ON l.id = c.livro_id`;

function inscricaoPublica(linha) {
  const { inicioEm, ...dados } = linha;
  // Preserva o Date do driver para serialização ISO UTC uniforme, inclusive
  // dentro da associação, sem depender do formato JSON de timestamp do PG.
  return { ...dados, encontro: { ...dados.encontro, inicioEm } };
}

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
  const linhas = await conexao.query(`${CONSULTA} WHERE i.encontro_id = $encontro AND i.usuario_id = $usuario`, {
    type: QueryTypes.SELECT, bind: { encontro: encontroId, usuario: usuarioId }, transaction,
  });
  return inscricaoPublica(exigirRecurso(linhas[0]));
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
  const bind = { usuario: usuarioId };
  // false/ausência preservam todo o histórico. true é um filtro temporal; um
  // evento futuro cancelado continua aparecendo com sua situação explícita.
  const filtro = futuros === 'true' ? ' AND e.inicio_em > $agora' : '';
  if (futuros === 'true') bind.agora = new Date(agora());
  return comContextoPersistencia('buscar', async () => {
    const [linhas, totais] = await Promise.all([
      conexao.query(`${CONSULTA} WHERE i.usuario_id = $usuario${filtro} ORDER BY e.inicio_em ASC, i.id ASC LIMIT $limite OFFSET $deslocamento`, {
        type: QueryTypes.SELECT, bind: { ...bind, limite: limit, deslocamento: offset },
      }),
      conexao.query(`SELECT count(*) AS total FROM inscricoes_encontro i JOIN encontros e ON e.id = i.encontro_id WHERE i.usuario_id = $usuario${filtro}`, {
        type: QueryTypes.SELECT, bind,
      }),
    ]);
    return { data: linhas.map(inscricaoPublica), meta: { page, pageSize, total: Number(totais[0].total) } };
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
