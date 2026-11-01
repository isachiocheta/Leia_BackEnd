'use strict';

const { QueryTypes, Transaction, Op } = require('sequelize');
const { bloquearLivro } = require('../database/bloqueio-livro');
const { bloquearCiclo } = require('../database/bloqueio-ciclo');
const { ErroAplicacao, MENSAGENS_CAMPOS } = require('../utilitarios/erro-aplicacao');
const { comContextoPersistencia, exigirRecurso } = require('../utilitarios/persistencia');
const { lerOpcoesListagem } = require('../utilitarios/listagem');
const { FUSO_CLUBE, dataCivilReal, dataEmSaoPaulo } = require('../utilitarios/datas-civis');

const CAMPOS_CRIACAO = Object.freeze(['nome', 'livroId', 'dataInicio', 'dataFim', 'orientacoes']);
const CAMPOS_EDICAO = Object.freeze([...CAMPOS_CRIACAO, 'situacao']);
const SITUACOES = Object.freeze(['PLANEJADO', 'EM_ANDAMENTO', 'CONCLUIDO']);
const ORDENACAO = Object.freeze({ id: 'id', nome: 'nome', dataInicio: 'data_inicio' });
const CONSULTA = `SELECT c.id, c.nome, c.livro_id AS "livroId", c.data_inicio::text AS "dataInicio",
  c.data_fim::text AS "dataFim", c.orientacoes, c.situacao, c.criado_em AS "criadoEm", c.atualizado_em AS "atualizadoEm",
  json_build_object('id', l.id, 'titulo', l.titulo, 'autor', l.autor, 'totalPaginas', l.total_paginas) AS livro
  FROM ciclos_leitura c JOIN livros l ON l.id = c.livro_id`;

function selecionar(entrada, campos) {
  return Object.fromEntries(campos.filter((campo) => Object.hasOwn(entrada, campo)).map((campo) => [campo, entrada[campo]]));
}

function conferirPeriodo(inicio, fim) {
  if (!dataCivilReal(inicio) || !dataCivilReal(fim) || inicio > fim) {
    throw new ErroAplicacao('VALIDATION_ERROR', {
      fields: [{ field: !dataCivilReal(inicio) ? 'dataInicio' : 'dataFim', message: MENSAGENS_CAMPOS.INVALID_DATE }],
    });
  }
}

async function consultarCiclo(id, conexao, transaction) {
  return comContextoPersistencia('buscar', async () => {
    const linhas = await conexao.query(`${CONSULTA} WHERE c.id = $id`, { type: QueryTypes.SELECT, bind: { id }, transaction });
    return exigirRecurso(linhas[0]);
  });
}

async function listarCiclos(consulta, conexao) {
  const { q, situacao, ...paginacao } = consulta;
  if ((situacao !== undefined && !SITUACOES.includes(situacao)) ||
    (paginacao.sort !== undefined && !['nome', 'dataInicio'].includes(paginacao.sort))) throw new ErroAplicacao('VALIDATION_ERROR');
  const { page, pageSize, limit, offset, order } = lerOpcoesListagem(paginacao, ORDENACAO, { padrao: 'dataInicio' });
  const filtros = [];
  const bind = {};
  if (q !== undefined) { filtros.push('c.nome ILIKE $termo'); bind.termo = `%${q.replace(/[\\%_]/g, '\\$&')}%`; }
  if (situacao !== undefined) { filtros.push('c.situacao = $situacao'); bind.situacao = situacao; }
  const where = filtros.length ? ` WHERE ${filtros.join(' AND ')}` : '';
  const ordenacao = order.map(([coluna, direcao]) => `c."${coluna}" ${direcao}`).join(', ');
  return comContextoPersistencia('buscar', async () => {
    const [data, totais] = await Promise.all([
      conexao.query(`${CONSULTA}${where} ORDER BY ${ordenacao} LIMIT $limite OFFSET $deslocamento`, {
        type: QueryTypes.SELECT, bind: { ...bind, limite: limit, deslocamento: offset },
      }),
      conexao.query(`SELECT count(*) AS total FROM ciclos_leitura c${where}`, { type: QueryTypes.SELECT, bind }),
    ]);
    return { data, meta: { page, pageSize, total: Number(totais[0].total) } };
  });
}

async function exigirSemDependencias(id, conexao, transaction) {
  const [linha] = await conexao.query(`SELECT
    EXISTS(SELECT 1 FROM participacoes_leitura WHERE ciclo_id = $id) OR
    EXISTS(SELECT 1 FROM encontros WHERE ciclo_id = $id) AS possui`, {
    type: QueryTypes.SELECT, bind: { id }, transaction,
  });
  if (linha.possui) throw new ErroAplicacao('RESOURCE_IN_USE');
}

async function conferirEncontrosNoPeriodo(id, inicio, fim, conexao, transaction) {
  // Compara a data local de cada instante, incluindo todas as horas do último
  // dia. Considera também encontros realizados e cancelados; não os modifica.
  const fora = await conexao.query(`SELECT id FROM encontros WHERE ciclo_id = $id
    AND timezone($fuso, inicio_em)::date NOT BETWEEN $inicio::date AND $fim::date LIMIT 1`, {
    type: QueryTypes.SELECT, bind: { id, fuso: FUSO_CLUBE, inicio, fim }, transaction,
  });
  if (fora.length) throw new ErroAplicacao('CONFLICT');
}

async function criarCiclo(entrada, conexao) {
  const dados = selecionar(entrada, CAMPOS_CRIACAO);
  conferirPeriodo(dados.dataInicio, dados.dataFim);
  return comContextoPersistencia('criar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    try { await bloquearLivro(conexao, dados.livroId, transaction); }
    catch (erro) { if (erro.codigo === 'NOT_FOUND') throw new ErroAplicacao('INVALID_REFERENCE'); throw erro; }
    const ciclo = await conexao.models.CicloLeitura.create({ ...dados, situacao: 'PLANEJADO' }, {
      fields: [...Object.keys(dados), 'situacao'], transaction,
    });
    return consultarCiclo(ciclo.id, conexao, transaction);
  }));
}

async function editarCiclo(id, entrada, conexao, { agora = Date.now } = {}) {
  const dados = selecionar(entrada, CAMPOS_EDICAO);
  return comContextoPersistencia('atualizar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const ciclo = await bloquearCiclo(conexao, id, transaction, dados.livroId);
    const inicio = Object.hasOwn(dados, 'dataInicio') ? dados.dataInicio : ciclo.dataInicio;
    const fim = Object.hasOwn(dados, 'dataFim') ? dados.dataFim : ciclo.dataFim;
    conferirPeriodo(inicio, fim);
    if (Object.hasOwn(dados, 'livroId') && dados.livroId !== ciclo.livroId) await exigirSemDependencias(id, conexao, transaction);
    if (inicio !== ciclo.dataInicio || fim !== ciclo.dataFim) await conferirEncontrosNoPeriodo(id, inicio, fim, conexao, transaction);
    if (Object.hasOwn(dados, 'situacao') && dados.situacao !== ciclo.situacao) {
      const proxima = { PLANEJADO: 'EM_ANDAMENTO', EM_ANDAMENTO: 'CONCLUIDO' }[ciclo.situacao];
      if (dados.situacao !== proxima) throw new ErroAplicacao('CONFLICT');
      if (proxima === 'EM_ANDAMENTO') {
        const hoje = dataEmSaoPaulo(agora());
        if (hoje < inicio || hoje > fim) throw new ErroAplicacao('CONFLICT');
        // Não bloqueia outro ciclo invertendo a ordem de locks. O índice único
        // parcial arbitra duas ativações que passaram simultaneamente nesta consulta.
        if (await conexao.models.CicloLeitura.findOne({
          where: { situacao: 'EM_ANDAMENTO', id: { [Op.ne]: id } }, attributes: ['id'], transaction,
        })) throw new ErroAplicacao('CONFLICT');
      } else if (await conexao.models.Encontro.findOne({ where: { cicloId: id, situacao: 'AGENDADO' }, attributes: ['id'], transaction })) {
        throw new ErroAplicacao('RESOURCE_IN_USE');
      }
    }
    await ciclo.update(dados, { fields: Object.keys(dados), transaction });
    return consultarCiclo(id, conexao, transaction);
  }));
}

async function excluirCiclo(id, conexao) {
  return comContextoPersistencia('excluir', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const ciclo = await bloquearCiclo(conexao, id, transaction);
    await exigirSemDependencias(id, conexao, transaction);
    await ciclo.destroy({ transaction });
  }));
}

module.exports = { CAMPOS_CRIACAO, CAMPOS_EDICAO, SITUACOES, listarCiclos, consultarCiclo, criarCiclo, editarCiclo, excluirCiclo };
