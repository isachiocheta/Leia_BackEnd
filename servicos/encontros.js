'use strict';

const { QueryTypes, Transaction } = require('sequelize');
const { bloquearCiclo } = require('../database/bloqueio-ciclo');
const { bloquearEncontro } = require('../database/bloqueio-encontro');
const { ErroAplicacao, MENSAGENS_CAMPOS } = require('../utilitarios/erro-aplicacao');
const { exigirRecurso, comContextoPersistencia } = require('../utilitarios/persistencia');
const { lerOpcoesListagem } = require('../utilitarios/listagem');
const { dataEmSaoPaulo } = require('../utilitarios/datas-civis');
const { instanteIsoComOffset } = require('../utilitarios/instantes');

const CAMPOS_CRIACAO = Object.freeze(['cicloId', 'titulo', 'inicioEm', 'local', 'descricao']);
const CAMPOS_EDICAO = Object.freeze([...CAMPOS_CRIACAO, 'situacao']);
const SITUACOES = Object.freeze(['AGENDADO', 'REALIZADO', 'CANCELADO']);
const ORDENACAO = Object.freeze({ id: 'id', titulo: 'titulo', inicioEm: 'inicio_em' });
const CONSULTA = `SELECT e.id, e.ciclo_id AS "cicloId", e.titulo, e.inicio_em AS "inicioEm", e.local, e.descricao, e.situacao,
  e.criado_em AS "criadoEm", e.atualizado_em AS "atualizadoEm",
  (SELECT count(*)::integer FROM inscricoes_encontro i WHERE i.encontro_id = e.id) AS "quantidadeInscritos",
  json_build_object('id', c.id, 'nome', c.nome, 'situacao', c.situacao) AS ciclo
  FROM encontros e JOIN ciclos_leitura c ON c.id = e.ciclo_id`;

function dadosEncontro(entrada, campos) {
  const dados = Object.fromEntries(campos.filter((campo) => Object.hasOwn(entrada, campo)).map((campo) => [campo, entrada[campo]]));
  if (Object.hasOwn(dados, 'inicioEm')) {
    if (!instanteIsoComOffset(dados.inicioEm)) throw inicioInvalido();
    dados.inicioEm = new Date(dados.inicioEm);
  }
  return dados;
}
function inicioInvalido() { return new ErroAplicacao('VALIDATION_ERROR', { fields: [{ field: 'inicioEm', message: MENSAGENS_CAMPOS.INVALID_VALUE }] }); }

function conferirAgendamento(ciclo, inicio, agora) {
  if (ciclo.situacao === 'CONCLUIDO') throw new ErroAplicacao('CONFLICT');
  const dia = dataEmSaoPaulo(inicio);
  if (inicio.getTime() <= agora() || dia < ciclo.dataInicio || dia > ciclo.dataFim) throw inicioInvalido();
}

async function consultarEncontro(id, conexao, transaction) {
  return comContextoPersistencia('buscar', async () => {
    const linhas = await conexao.query(`${CONSULTA} WHERE e.id = $id`, { type: QueryTypes.SELECT, bind: { id }, transaction });
    return exigirRecurso(linhas[0]);
  });
}

async function listarEncontros(consulta, conexao) {
  const { q, cicloId, situacao, ...paginacao } = consulta;
  if ((situacao !== undefined && !SITUACOES.includes(situacao)) ||
    (paginacao.sort !== undefined && !['titulo', 'inicioEm'].includes(paginacao.sort))) throw new ErroAplicacao('VALIDATION_ERROR');
  const { page, pageSize, limit, offset, order } = lerOpcoesListagem(paginacao, ORDENACAO, { padrao: 'inicioEm' });
  const filtros = [];
  const bind = {};
  if (q !== undefined) { filtros.push('e.titulo ILIKE $termo'); bind.termo = `%${q.replace(/[\\%_]/g, '\\$&')}%`; }
  if (cicloId !== undefined) { filtros.push('e.ciclo_id = $ciclo'); bind.ciclo = cicloId; }
  if (situacao !== undefined) { filtros.push('e.situacao = $situacao'); bind.situacao = situacao; }
  const where = filtros.length ? ` WHERE ${filtros.join(' AND ')}` : '';
  const ordenacao = order.map(([coluna, direcao]) => `e."${coluna}" ${direcao}`).join(', ');
  return comContextoPersistencia('buscar', async () => {
    const [data, totais] = await Promise.all([
      conexao.query(`${CONSULTA}${where} ORDER BY ${ordenacao} LIMIT $limite OFFSET $deslocamento`, {
        type: QueryTypes.SELECT, bind: { ...bind, limite: limit, deslocamento: offset },
      }),
      conexao.query(`SELECT count(*) AS total FROM encontros e${where}`, { type: QueryTypes.SELECT, bind }),
    ]);
    return { data, meta: { page, pageSize, total: Number(totais[0].total) } };
  });
}

async function criarEncontro(entrada, conexao, { agora = Date.now } = {}) {
  const dados = dadosEncontro(entrada, CAMPOS_CRIACAO);
  return comContextoPersistencia('criar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    let ciclo;
    try { ciclo = await bloquearCiclo(conexao, dados.cicloId, transaction); }
    catch (erro) { if (erro.codigo === 'NOT_FOUND') throw new ErroAplicacao('INVALID_REFERENCE'); throw erro; }
    conferirAgendamento(ciclo, dados.inicioEm, agora);
    const encontro = await conexao.models.Encontro.create({ ...dados, situacao: 'AGENDADO' }, {
      fields: [...Object.keys(dados), 'situacao'], transaction,
    });
    return consultarEncontro(encontro.id, conexao, transaction);
  }));
}

async function editarEncontro(id, entrada, conexao, { agora = Date.now } = {}) {
  const dados = dadosEncontro(entrada, CAMPOS_EDICAO);
  return comContextoPersistencia('atualizar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const { encontro, destino } = await bloquearEncontro(conexao, id, transaction, dados.cicloId);
    const inicio = dados.inicioEm ?? encontro.inicioEm;
    const trocandoCiclo = Object.hasOwn(dados, 'cicloId') && dados.cicloId !== encontro.cicloId;
    const reagendando = Object.hasOwn(dados, 'inicioEm') && inicio.getTime() !== encontro.inicioEm.getTime();
    const situacao = dados.situacao ?? encontro.situacao;
    if (!SITUACOES.includes(situacao)) throw new ErroAplicacao('VALIDATION_ERROR');
    if (encontro.situacao !== 'AGENDADO') {
      if (situacao !== encontro.situacao || trocandoCiclo || reagendando) throw new ErroAplicacao('CONFLICT');
    } else {
      if (trocandoCiclo && await conexao.models.InscricaoEncontro.findOne({ where: { encontroId: id }, attributes: ['id'], transaction })) {
        throw new ErroAplicacao('RESOURCE_IN_USE');
      }
      if (trocandoCiclo || reagendando) conferirAgendamento(destino, inicio, agora);
      if (situacao === 'REALIZADO' && inicio.getTime() > agora()) throw new ErroAplicacao('CONFLICT');
    }
    await encontro.update(dados, { fields: Object.keys(dados), transaction });
    return consultarEncontro(id, conexao, transaction);
  }));
}

async function excluirEncontro(id, conexao) {
  return comContextoPersistencia('excluir', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const { encontro } = await bloquearEncontro(conexao, id, transaction);
    // A FK CASCADE das inscrições é a autoridade da limpeza física. Nenhuma
    // participação, usuário, ciclo ou outro encontro é removido por este serviço.
    await encontro.destroy({ transaction });
  }));
}

module.exports = { CAMPOS_CRIACAO, CAMPOS_EDICAO, SITUACOES, listarEncontros, consultarEncontro, criarEncontro, editarEncontro, excluirEncontro };
