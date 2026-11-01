'use strict';

const { QueryTypes, Transaction } = require('sequelize');
const { ErroAplicacao, MENSAGENS_CAMPOS } = require('../utilitarios/erro-aplicacao');
const { comContextoPersistencia, exigirRecurso } = require('../utilitarios/persistencia');
const { lerOpcoesListagem } = require('../utilitarios/listagem');
const { bloquearLivro } = require('../database/bloqueio-livro');

const CAMPOS_LIVRO = Object.freeze(['titulo', 'autor', 'generoId', 'totalPaginas', 'anoPublicacao', 'descricao', 'capaUrl']);
const ORDENACAO = Object.freeze({ id: 'id', titulo: 'titulo', anoPublicacao: 'ano_publicacao' });
const CONSULTA_LIVRO = `SELECT l.id, l.titulo, l.autor, l.genero_id AS "generoId",
  l.total_paginas AS "totalPaginas", l.ano_publicacao AS "anoPublicacao",
  l.descricao, l.capa_url AS "capaUrl", l.criado_em AS "criadoEm", l.atualizado_em AS "atualizadoEm",
  json_build_object('id', g.id, 'nome', g.nome) AS genero
  FROM livros l JOIN generos g ON g.id = l.genero_id`;

function anoAtual() { return new Date().getFullYear(); }

function dadosLivro(entrada) {
  const dados = Object.fromEntries(CAMPOS_LIVRO.filter((campo) => Object.hasOwn(entrada, campo)).map((campo) => [campo, entrada[campo]]));
  if (Object.hasOwn(dados, 'anoPublicacao') && dados.anoPublicacao !== null &&
    (!Number.isInteger(dados.anoPublicacao) || dados.anoPublicacao < 1 || dados.anoPublicacao > anoAtual())) {
    throw new ErroAplicacao('VALIDATION_ERROR', { fields: [{ field: 'anoPublicacao', message: MENSAGENS_CAMPOS.INVALID_VALUE }] });
  }
  return dados;
}

async function listarGeneros(consulta, conexao) {
  const { page, pageSize, limit, offset } = lerOpcoesListagem(consulta, { id: 'id', nome: 'nome' }, { padrao: 'nome' });
  return comContextoPersistencia('buscar', async () => {
    const [data, totais] = await Promise.all([
      conexao.query('SELECT id, nome FROM generos ORDER BY nome ASC, id ASC LIMIT $limite OFFSET $deslocamento', {
        type: QueryTypes.SELECT, bind: { limite: limit, deslocamento: offset },
      }),
      conexao.query('SELECT count(*) AS total FROM generos', { type: QueryTypes.SELECT }),
    ]);
    return { data, meta: { page, pageSize, total: Number(totais[0].total) } };
  });
}

async function listarLivros(consulta, conexao) {
  const { q, generoId, ...paginacao } = consulta;
  if (paginacao.sort !== undefined && !['titulo', 'anoPublicacao'].includes(paginacao.sort)) {
    throw new ErroAplicacao('VALIDATION_ERROR');
  }
  const { page, pageSize, limit, offset, order } = lerOpcoesListagem(paginacao, ORDENACAO, { padrao: 'titulo' });
  const filtros = [];
  const bind = {};
  if (q !== undefined) {
    // Busca literal, sem interpretar % e _ do usuário como curingas do ILIKE.
    bind.termo = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    filtros.push('(l.titulo ILIKE $termo OR l.autor ILIKE $termo)');
  }
  if (generoId !== undefined) { filtros.push('l.genero_id = $genero'); bind.genero = generoId; }
  const where = filtros.length ? ` WHERE ${filtros.join(' AND ')}` : '';
  // Somente colunas do mapa interno e direções validadas compõem o SQL.
  // Anos desconhecidos ficam ao final em ambas as direções, com id no desempate.
  const ordenacao = order.map(([coluna, direcao]) => `l."${coluna}" ${direcao}${coluna === 'ano_publicacao' ? ' NULLS LAST' : ''}`).join(', ');
  return comContextoPersistencia('buscar', async () => {
    const [data, totais] = await Promise.all([
      conexao.query(`${CONSULTA_LIVRO}${where} ORDER BY ${ordenacao} LIMIT $limite OFFSET $deslocamento`, {
        type: QueryTypes.SELECT, bind: { ...bind, limite: limit, deslocamento: offset },
      }),
      conexao.query(`SELECT count(*) AS total FROM livros l${where}`, { type: QueryTypes.SELECT, bind }),
    ]);
    return { data, meta: { page, pageSize, total: Number(totais[0].total) } };
  });
}

async function consultarLivro(id, conexao, transaction) {
  return comContextoPersistencia('buscar', async () => {
    const livros = await conexao.query(`${CONSULTA_LIVRO} WHERE l.id = $id`, {
      type: QueryTypes.SELECT, bind: { id }, transaction,
    });
    return exigirRecurso(livros[0]);
  });
}

async function conferirGenero(id, conexao, transaction) {
  const genero = await conexao.models.Genero.findByPk(id, {
    attributes: ['id'], transaction, lock: transaction.LOCK.KEY_SHARE,
  });
  if (!genero) throw new ErroAplicacao('INVALID_REFERENCE', {
    fields: [{ field: 'generoId', message: MENSAGENS_CAMPOS.INVALID_VALUE }],
  });
}

async function exigirLivroSemCiclos(id, conexao, transaction) {
  // Todos os ciclos contam, inclusive planejados e concluídos. O schema já está
  // completo e as dependências existem independentemente de suas rotas HTTP.
  // READ COMMITTED permite ver o ciclo que terminou de gravar enquanto o livro
  // estava aguardando o lock, sem reutilizar um snapshot anterior à espera.
  if (await conexao.models.CicloLeitura.findOne({ where: { livroId: id }, attributes: ['id'], transaction })) {
    throw new ErroAplicacao('RESOURCE_IN_USE');
  }
}

async function criarLivro(entrada, conexao) {
  const dados = dadosLivro(entrada);
  return comContextoPersistencia('criar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    await conferirGenero(dados.generoId, conexao, transaction);
    const livro = await conexao.models.Livro.create(dados, { fields: Object.keys(dados), transaction });
    return consultarLivro(livro.id, conexao, transaction);
  }));
}

async function editarLivro(id, entrada, conexao) {
  const dados = dadosLivro(entrada);
  return comContextoPersistencia('atualizar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const livro = await bloquearLivro(conexao, id, transaction);
    if (Object.hasOwn(dados, 'totalPaginas') && dados.totalPaginas !== livro.totalPaginas) {
      await exigirLivroSemCiclos(id, conexao, transaction);
    }
    if (Object.hasOwn(dados, 'generoId')) await conferirGenero(dados.generoId, conexao, transaction);
    await livro.update(dados, { fields: Object.keys(dados), transaction });
    return consultarLivro(id, conexao, transaction);
  }));
}

async function excluirLivro(id, conexao) {
  return comContextoPersistencia('excluir', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const livro = await bloquearLivro(conexao, id, transaction);
    await exigirLivroSemCiclos(id, conexao, transaction);
    await livro.destroy({ transaction });
  }));
}

module.exports = { CAMPOS_LIVRO, anoAtual, listarGeneros, listarLivros, consultarLivro, criarLivro, editarLivro, excluirLivro };
