'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const { query } = require('express-validator');
const { criarConexao } = require('../../database/conexao');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { configurarHttp } = require('../../intermediarios/http');
const { tratarErros, rotaNaoEncontrada } = require('../../intermediarios/erros');
const { responderDetalhe, responderLista } = require('../../utilitarios/respostas');
const { comContextoPersistencia, exigirRecurso } = require('../../utilitarios/persistencia');
const { lerOpcoesListagem } = require('../../utilitarios/listagem');
const {
  validarIdPositivo, validarRequisicao, rejeitarCamposDesconhecidos, selecionarCamposPermitidos,
} = require('../../validacao/requisicao');

validarBancoTeste(process.env);

// Aplicação exclusiva deste arquivo de teste. Nenhuma destas rotas é registrada
// no app público. Valores usam bind; identificadores vêm apenas destes mapas.
const prefixo = 'Contrato de persistência';
const mapaOrdenacao = Object.freeze({ id: 'id', nome: 'nome' });
const colunasSql = Object.freeze({ id: '"id"', nome: '"nome"' });

describe('Contratos HTTP com erros reais de PostgreSQL', { timeout: 20_000 }, () => {
  let conexao;
  let servidor;
  let endereco;
  let contexto;

  async function comSavepoint(operacao, executar) {
    validarDestinoTeste(conexao);
    return comContextoPersistencia(operacao, async () => {
      try {
        return await conexao.transaction({ transaction: contexto.transaction }, executar);
      } catch (erro) {
        contexto.erros.push({ nome: erro.name, sqlstate: erro.original?.code });
        throw erro;
      }
    });
  }

  before(async () => {
    conexao = criarConexao();
    validarDestinoTeste(conexao);
    await conexao.authenticate();
    const aplicacao = express();
    configurarHttp(aplicacao, { origemPermitida: 'http://localhost:5173' });

    aplicacao.get('/fixture/detalhe/:id', validarIdPositivo(), validarRequisicao, async (requisicao, resposta) => {
      const [linhas] = await comContextoPersistencia('buscar', () => conexao.query(
        'SELECT id, nome FROM generos WHERE id = $1',
        { bind: [requisicao.params.id], transaction: contexto.transaction },
      ));
      return responderDetalhe(resposta, exigirRecurso(linhas[0]));
    });

    aplicacao.get('/fixture/lista',
      rejeitarCamposDesconhecidos(['page', 'pageSize', 'sort', 'direction', 'termo'], { local: 'query' }),
      query('termo').optional().isString().bail().isLength({ max: 120 }).withMessage('INVALID_VALUE'),
      validarRequisicao,
      async (requisicao, resposta) => {
        const consulta = requisicao.query;
        const opcoes = lerOpcoesListagem({
          page: consulta.page, pageSize: consulta.pageSize, sort: consulta.sort, direction: consulta.direction,
        }, mapaOrdenacao);
        const filtros = selecionarCamposPermitidos(requisicao, ['termo'], { local: 'query' });
        const termo = `%${filtros.termo ?? prefixo}%`;
        const ordem = opcoes.order.map(([coluna, direcao]) => `${colunasSql[coluna]} ${direcao}`).join(', ');
        const [linhas] = await conexao.query(`
          SELECT id, nome FROM generos WHERE nome ILIKE $1
          ORDER BY ${ordem} LIMIT $2 OFFSET $3
        `, { bind: [termo, opcoes.limit, opcoes.offset], transaction: contexto.transaction });
        const [totais] = await conexao.query('SELECT COUNT(*)::integer AS total FROM generos WHERE nome ILIKE $1', {
          bind: [termo], transaction: contexto.transaction,
        });
        return responderLista(resposta, linhas, { page: opcoes.page, pageSize: opcoes.pageSize, total: totais[0].total });
      });

    aplicacao.post('/fixture/referencia-invalida', async (requisicao, resposta) => {
      const [linhas] = await comSavepoint('criar', (transaction) => conexao.query(`
        INSERT INTO livros (titulo, autor, genero_id, total_paginas, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
      `, { bind: ['senha_reservada; SELECT senha_hash FROM usuarios', 'Autora', 2147483647, 10], transaction }));
      return responderDetalhe(resposta, linhas[0], 201);
    });

    aplicacao.post('/fixture/duplicidade', async (requisicao, resposta) => {
      const [linhas] = await comSavepoint('criar', (transaction) => conexao.query(`
        INSERT INTO generos (nome, criado_em, atualizado_em)
        VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
      `, { bind: [`${prefixo} A`], transaction }));
      return responderDetalhe(resposta, linhas[0], 201);
    });

    aplicacao.delete('/fixture/dependencia', async (requisicao, resposta) => {
      await comSavepoint('excluir', (transaction) => conexao.query('DELETE FROM generos WHERE id = $1', {
        bind: [contexto.generoId], transaction,
      }));
      resposta.status(204).end();
    });

    aplicacao.post('/fixture/check', async (requisicao, resposta) => {
      const [linhas] = await comSavepoint('criar', (transaction) => conexao.query(`
        INSERT INTO generos (nome, criado_em, atualizado_em)
        VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
      `, { bind: [' \t\n '], transaction }));
      return responderDetalhe(resposta, linhas[0], 201);
    });

    aplicacao.use(rotaNaoEncontrada);
    aplicacao.use(tratarErros);
    servidor = aplicacao.listen(0, '127.0.0.1');
    await once(servidor, 'listening');
    endereco = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    if (servidor) {
      await new Promise((resolver, rejeitar) => {
        servidor.close((erro) => erro ? rejeitar(erro) : resolver());
        servidor.closeAllConnections();
      });
    }
    if (conexao) await conexao.close();
  });

  async function emTransacao(executar) {
    validarDestinoTeste(conexao);
    const transaction = await conexao.transaction();
    contexto = { transaction, erros: [] };
    try {
      const [generos] = await conexao.query(`
        INSERT INTO generos (nome, criado_em, atualizado_em)
        VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
               ($2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id, nome
      `, { bind: [`${prefixo} A`, `${prefixo} B`], transaction });
      contexto.generoId = generos[0].id;
      contexto.generos = generos;
      const [livros] = await conexao.query(`
        INSERT INTO livros (titulo, autor, genero_id, total_paginas, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
      `, { bind: ['Obra do contrato', 'Autora', contexto.generoId, 20], transaction });
      contexto.livroId = livros[0].id;
      await executar(contexto);
    } finally {
      contexto = undefined;
      validarDestinoTeste(conexao);
      await transaction.rollback();
    }
  }

  async function conferirErro(resposta, status, codigo) {
    assert.equal(resposta.status, status);
    assert.match(resposta.headers.get('content-type'), /application\/json/);
    const corpo = await resposta.json();
    assert.deepEqual(Object.keys(corpo), ['error']);
    assert.equal(corpo.error.code, codigo);
    assert.equal(typeof corpo.error.message, 'string');
    assert.ok(Object.keys(corpo.error).every((chave) => ['code', 'message', 'fields'].includes(chave)));
    assert.doesNotMatch(JSON.stringify(corpo), /SELECT\s|INSERT\s|DELETE\s|DROP\s|postgresql:\/\/|senha_reservada|senha_hash|"stack"|"sql"|"original"|"parameters"/i);
    return corpo;
  }

  it('envolve um resultado real de detalhe em data', async () => {
    await emTransacao(async ({ generoId }) => {
      const resposta = await fetch(`${endereco}/fixture/detalhe/${generoId}`);
      assert.equal(resposta.status, 200);
      assert.deepEqual(await resposta.json(), { data: { id: generoId, nome: `${prefixo} A` } });
    });
  });

  it('lista resultados reais com paginação, ordenação interna e metadados', async () => {
    await emTransacao(async ({ generoId }) => {
      const resposta = await fetch(`${endereco}/fixture/lista?page=2&pageSize=1&sort=nome&direction=desc`);
      assert.equal(resposta.status, 200);
      assert.deepEqual(await resposta.json(), {
        data: [{ id: generoId, nome: `${prefixo} A` }], meta: { page: 2, pageSize: 1, total: 2 },
      });
    });
  });

  it('alvo ausente após SELECT real resulta em 404', async () => {
    await emTransacao(async () => {
      await conferirErro(await fetch(`${endereco}/fixture/detalhe/2147483647`), 404, 'NOT_FOUND');
    });
  });

  it('referência inexistente ao criar resulta em 422 sem expor SQL ou valores', async () => {
    await emTransacao(async (fixture) => {
      await conferirErro(await fetch(`${endereco}/fixture/referencia-invalida`, { method: 'POST' }), 422, 'INVALID_REFERENCE');
      assert.deepEqual(fixture.erros, [{ nome: 'SequelizeForeignKeyConstraintError', sqlstate: '23503' }]);
    });
  });

  it('unicidade real resulta em 409 sem expor o valor duplicado', async () => {
    await emTransacao(async (fixture) => {
      const corpo = await conferirErro(await fetch(`${endereco}/fixture/duplicidade`, { method: 'POST' }), 409, 'DUPLICATE_RESOURCE');
      assert.ok(!JSON.stringify(corpo).includes(prefixo));
      assert.deepEqual(fixture.erros, [{ nome: 'SequelizeUniqueConstraintError', sqlstate: '23505' }]);
    });
  });

  it('exclusão com dependência real resulta em 409 e conserva os registros', async () => {
    await emTransacao(async (fixture) => {
      await conferirErro(await fetch(`${endereco}/fixture/dependencia`, { method: 'DELETE' }), 409, 'RESOURCE_IN_USE');
      assert.deepEqual(fixture.erros, [{ nome: 'SequelizeForeignKeyConstraintError', sqlstate: '23503' }]);
      assert.ok(await conexao.models.Genero.findByPk(fixture.generoId, { transaction: fixture.transaction }));
      assert.ok(await conexao.models.Livro.findByPk(fixture.livroId, { transaction: fixture.transaction }));
    });
  });

  it('violação real de CHECK resulta em 422 com contexto seguro', async () => {
    await emTransacao(async (fixture) => {
      await conferirErro(await fetch(`${endereco}/fixture/check`, { method: 'POST' }), 422, 'VALIDATION_ERROR');
      assert.deepEqual(fixture.erros, [{ nome: 'SequelizeDatabaseError', sqlstate: '23514' }]);
    });
  });

  it('valores de busca são bind e ordenação maliciosa não chega ao SQL', async () => {
    await emTransacao(async ({ transaction, generos }) => {
      const ataque = "' OR 1=1; DROP TABLE generos; -- senha_reservada";
      const resposta = await fetch(`${endereco}/fixture/lista?termo=${encodeURIComponent(ataque)}`);
      assert.equal(resposta.status, 200);
      assert.deepEqual(await resposta.json(), { data: [], meta: { page: 1, pageSize: 12, total: 0 } });
      const ordenacao = await fetch(`${endereco}/fixture/lista?sort=${encodeURIComponent(ataque)}`);
      const corpo = await conferirErro(ordenacao, 422, 'VALIDATION_ERROR');
      assert.ok(!JSON.stringify(corpo).includes(ataque));
      assert.equal(await conexao.models.Genero.count({ where: { id: generos.map((genero) => genero.id) }, transaction }), 2);
    });
  });
});
