'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const { body } = require('express-validator');
const {
  ConnectionError, DatabaseError, EmptyResultError, ForeignKeyConstraintError,
  UniqueConstraintError, ValidationError, ValidationErrorItem,
} = require('sequelize');
const { configurarHttp } = require('../intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('../intermediarios/erros');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');
const { exigirRecurso, comContextoPersistencia } = require('../utilitarios/persistencia');
const { responderDetalhe, responderLista, responderSemConteudo } = require('../utilitarios/respostas');
const { lerOpcoesListagem } = require('../utilitarios/listagem');
const {
  validarIdPositivo, validarDataCivil, validarRequisicao,
  rejeitarCamposDesconhecidos, rejeitarPatchVazio, selecionarCamposPermitidos,
} = require('../validacao/requisicao');

const origemPermitida = 'http://localhost:5173';
const segredo = 'SELECT senha_hash FROM usuarios; postgresql://usuario:senha_reservada@host/banco';
const codigosPorStatus = new Map([
  [400, 'BAD_REQUEST'], [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'],
  [409, 'CONFLICT'], [413, 'PAYLOAD_TOO_LARGE'], [422, 'VALIDATION_ERROR'],
  [429, 'TOO_MANY_REQUESTS'], [500, 'INTERNAL_ERROR'], [503, 'SERVICE_UNAVAILABLE'],
]);

function falhaOriginal(codigo) {
  return Object.assign(new Error(segredo), { code: codigo, sql: segredo, stack: segredo });
}

function criarAplicacaoControlada() {
  // Estas rotas existem somente nesta aplicação de testes, nunca em app.js.
  const app = express();
  configurarHttp(app, { origemPermitida });

  app.get('/detalhe', (requisicao, resposta) => responderDetalhe(resposta, { id: 7, nome: 'Referência' }));
  app.get('/lista', (requisicao, resposta) => {
    const mapa = Object.freeze({ id: 'id', nome: 'nome_interno', criadoEm: 'criado_em' });
    const opcoes = lerOpcoesListagem(requisicao.query, mapa, { padrao: 'nome' });
    const registros = [
      { id: 10, nome_interno: 'A', criado_em: 3 },
      { id: 2, nome_interno: 'A', criado_em: 1 },
      { id: 9, nome_interno: 'B', criado_em: 2 },
    ];
    registros.sort((a, b) => {
      for (const [campo, direcao] of opcoes.order) {
        const comparacao = typeof a[campo] === 'number'
          ? a[campo] - b[campo] : a[campo].localeCompare(b[campo]);
        if (comparacao !== 0) return direcao === 'ASC' ? comparacao : -comparacao;
      }
      return 0;
    });
    const pagina = registros.slice(opcoes.offset, opcoes.offset + opcoes.limit)
      .map((registro) => ({ id: registro.id, nome: registro.nome_interno }));
    return responderLista(resposta, pagina, { page: opcoes.page, pageSize: opcoes.pageSize, total: registros.length });
  });
  app.delete('/sem-conteudo', (requisicao, resposta) => {
    resposta.set('Content-Type', 'text/plain');
    return responderSemConteudo(resposta);
  });
  app.delete('/detalhe-sem-conteudo', (requisicao, resposta) => responderDetalhe(resposta, { segredo }, 204));
  app.delete('/lista-sem-conteudo', (requisicao, resposta) => responderLista(resposta, [], { page: 1, pageSize: 12, total: 0 }, 204));
  app.get('/detalhe-date', (requisicao, resposta) => responderDetalhe(resposta, new Date('2026-10-31T12:00:00Z')));
  app.get('/detalhe-tojson-array', (requisicao, resposta) => responderDetalhe(resposta, { toJSON: () => [] }));
  app.get('/lista-tojson-objeto', (requisicao, resposta) => {
    const dados = [];
    dados.toJSON = () => ({ segredo });
    return responderLista(resposta, dados, { page: 1, pageSize: 12, total: 0 });
  });
  app.get('/detalhe-circular', (requisicao, resposta) => {
    const dados = { segredo };
    dados.circular = dados;
    return responderDetalhe(resposta, dados);
  });

  app.get('/erro/:status', (requisicao, resposta, proximo) => {
    const erro = falhaOriginal(segredo);
    erro.status = Number(requisicao.params.status);
    erro.fields = [{ field: 'senha', value: segredo, message: segredo }];
    proximo(erro);
  });
  app.get('/erro-aplicacao', (requisicao, resposta, proximo) => {
    const erro = new ErroAplicacao('VALIDATION_ERROR', {
      fields: [{ field: 'senhaHash', message: 'Valor inválido.', value: segredo }],
    });
    erro.message = segredo;
    erro.sql = segredo;
    erro.fields.push({ field: segredo, message: segredo, value: segredo });
    proximo(erro);
  });
  app.get('/sequelize/:caso', async (requisicao, resposta) => {
    const caso = requisicao.params.caso;
    if (caso === 'alvo') return comContextoPersistencia('buscar', async () => exigirRecurso(null));
    if (caso === 'vazio') throw new EmptyResultError(segredo);
    if (caso === 'referencia' || caso === 'dependencia') {
      return comContextoPersistencia(caso === 'referencia' ? 'criar' : 'excluir', async () => {
        throw new ForeignKeyConstraintError({ parent: falhaOriginal('23503'), fields: { genero_id: segredo } });
      });
    }
    if (caso === 'duplicidade') {
      throw new UniqueConstraintError({
        message: segredo, parent: falhaOriginal('23505'),
        errors: [new ValidationErrorItem(segredo, 'unique violation', 'email', segredo)],
      });
    }
    if (caso === 'validacao') {
      throw new ValidationError(segredo, [new ValidationErrorItem(segredo, 'Validation error', 'senhaHash', segredo)]);
    }
    if (caso === 'conexao') throw new ConnectionError(falhaOriginal('08006'));
    if (caso === 'inesperado') throw new DatabaseError(falhaOriginal('XX000'));
    throw new ErroAplicacao('NOT_FOUND');
  });

  const permitidos = ['nome', 'data', 'senha', 'zero', 'falso', 'nulo'];
  function regrasEntrada(patch = false) {
    const nome = body('nome');
    if (patch) nome.optional();
    return [
      rejeitarCamposDesconhecidos(permitidos),
      ...(patch ? [rejeitarPatchVazio(permitidos)] : []),
      validarIdPositivo(),
      nome.isString().notEmpty().withMessage('REQUIRED'),
      validarDataCivil('data', { opcional: true }),
      body('senha').optional().isString().withMessage('INVALID_VALUE'),
      body('zero').optional().isInt({ min: 0 }).withMessage('INVALID_VALUE').bail().toInt(),
      body('falso').optional().custom((valor) => typeof valor === 'boolean').withMessage('INVALID_VALUE'),
      body('nulo').optional().custom((valor) => valor === null).withMessage('INVALID_VALUE'),
      validarRequisicao,
    ];
  }
  function retornarSelecionados(requisicao, resposta) {
    const dados = selecionarCamposPermitidos(requisicao, ['nome', 'data', 'zero', 'falso', 'nulo']);
    const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
    return responderDetalhe(resposta, { id, ...dados });
  }
  app.post('/entrada/:id', ...regrasEntrada(), retornarSelecionados);
  app.patch('/entrada/:id', ...regrasEntrada(true), retornarSelecionados);
  app.post('/validar-senha',
    rejeitarCamposDesconhecidos(['senha']),
    body('senha').custom(() => false).withMessage((valor) => `senha:${valor}`),
    validarRequisicao,
    (requisicao, resposta) => responderSemConteudo(resposta));
  app.post('/json', (requisicao, resposta) => responderDetalhe(resposta, { conteudo: requisicao.body }));
  app.use(rotaNaoEncontrada);
  app.use(tratarErros);
  return app;
}

describe('Contratos HTTP em aplicação controlada', { timeout: 30_000 }, () => {
  let servidor;
  let endereco;

  before(async () => {
    servidor = criarAplicacaoControlada().listen(0, '127.0.0.1');
    await once(servidor, 'listening');
    endereco = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    if (!servidor) return;
    await new Promise((resolver, rejeitar) => {
      servidor.close((erro) => erro ? rejeitar(erro) : resolver());
      servidor.closeAllConnections();
    });
  });

  function requisitar(caminho, opcoes = {}) {
    return fetch(`${endereco}${caminho}`, { ...opcoes, signal: AbortSignal.timeout(10_000) });
  }

  function enviar(caminho, dados, method = 'POST') {
    return requisitar(caminho, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) });
  }

  async function conferirErro(resposta, status, codigo) {
    assert.equal(resposta.status, status);
    assert.match(resposta.headers.get('content-type'), /application\/json/);
    const texto = await resposta.text();
    assert.doesNotMatch(texto, /senha_reservada|SELECT|postgresql:|senha_hash|stack|"value"|"sql"|"cause"/);
    const corpo = JSON.parse(texto);
    assert.deepEqual(Object.keys(corpo), ['error']);
    assert.equal(corpo.error.code, codigo);
    assert.equal(typeof corpo.error.message, 'string');
    assert.ok(corpo.error.message.length > 0);
    for (const chave of Object.keys(corpo.error)) assert.ok(['code', 'message', 'fields'].includes(chave));
    return corpo;
  }

  it('retorna o envelope de detalhe', async () => {
    const resposta = await requisitar('/detalhe');
    assert.equal(resposta.status, 200);
    assert.deepEqual(await resposta.json(), { data: { id: 7, nome: 'Referência' } });
  });

  it('retorna lista com página1, doze registros e desempate numérico por id', async () => {
    const resposta = await requisitar('/lista');
    assert.deepEqual(await resposta.json(), {
      data: [{ id: 2, nome: 'A' }, { id: 10, nome: 'A' }, { id: 9, nome: 'B' }],
      meta: { page: 1, pageSize: 12, total: 3 },
    });
  });

  it('respeita paginação, direção e mapa privado de ordenação', async () => {
    const resposta = await requisitar('/lista?page=2&pageSize=1&sort=nome&direction=desc');
    assert.deepEqual(await resposta.json(), { data: [{ id: 10, nome: 'A' }], meta: { page: 2, pageSize: 1, total: 3 } });
    const criado = await requisitar('/lista?sort=criadoEm');
    const corpo = await criado.json();
    assert.deepEqual(corpo.data.map((item) => item.id), [2, 9, 10]);
    assert.doesNotMatch(JSON.stringify(corpo), /nome_interno|criado_em|order|offset|limit/);
    const limite = await requisitar('/lista?pageSize=50');
    assert.equal((await limite.json()).meta.pageSize, 50);
  });

  it('rejeita injeção e parâmetros de ordenação/paginação não permitidos', async () => {
    for (const consulta of [
      `sort=${encodeURIComponent(segredo)}`, 'sort=nome_interno', 'sort=senhaHash',
      'direction=desc%20NULLS%20FIRST', 'page=1%20OR%201%3D1',
      'pageSize=51', 'page=0', 'page=1&page=2', 'extra=ADMIN_CLUBE',
    ]) {
      await conferirErro(await requisitar(`/lista?${consulta}`), 422, 'VALIDATION_ERROR');
    }
  });

  it('todos os helpers de resposta mantêm 204 vazio e sem tipo de conteúdo', async () => {
    for (const caminho of ['/sem-conteudo', '/detalhe-sem-conteudo', '/lista-sem-conteudo']) {
      const resposta = await requisitar(caminho, { method: 'DELETE' });
      assert.equal(resposta.status, 204);
      assert.equal(await resposta.text(), '');
      assert.equal(resposta.headers.get('content-type'), null);
      assert.equal(resposta.headers.get('transfer-encoding'), null);
    }
  });

  it('HEAD mantém cabeçalhos do detalhe com corpo vazio', async () => {
    const resposta = await requisitar('/detalhe', { method: 'HEAD' });
    assert.equal(resposta.status, 200);
    assert.match(resposta.headers.get('content-type'), /application\/json/);
    assert.equal(await resposta.text(), '');
  });

  it('serialização não pode trocar o tipo do envelope ou expor um payload circular', async (t) => {
    t.mock.method(console, 'error', () => {});
    for (const caminho of ['/detalhe-date', '/detalhe-tojson-array', '/lista-tojson-objeto', '/detalhe-circular']) {
      await t.test(caminho, async () => conferirErro(await requisitar(caminho), 500, 'INTERNAL_ERROR'));
    }
  });

  it('padroniza os dez status de erro sem expor propriedades do erro original', async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    for (const [status, codigo] of codigosPorStatus) {
      await t.test(String(status), async () => conferirErro(await requisitar(`/erro/${status}`), status, codigo));
    }
    assert.ok(log.mock.calls.every((chamada) => chamada.arguments.every((argumento) => typeof argumento === 'string' && !argumento.includes(segredo))));
  });

  it('revalida mensagens e campos até de um ErroAplicacao alterado depois da criação', async () => {
    const corpo = await conferirErro(await requisitar('/erro-aplicacao'), 422, 'VALIDATION_ERROR');
    assert.deepEqual(corpo.error.fields, [
      { field: 'senha', message: 'Valor inválido.' },
      { field: 'body', message: 'Valor inválido.' },
    ]);
  });

  it('traduz erros reais das classes Sequelize pelo contexto seguro', async (t) => {
    t.mock.method(console, 'error', () => {});
    for (const [caso, status, codigo] of [
      ['alvo', 404, 'NOT_FOUND'], ['vazio', 404, 'NOT_FOUND'],
      ['referencia', 422, 'INVALID_REFERENCE'], ['dependencia', 409, 'RESOURCE_IN_USE'],
      ['duplicidade', 409, 'DUPLICATE_RESOURCE'], ['validacao', 422, 'VALIDATION_ERROR'],
      ['conexao', 503, 'SERVICE_UNAVAILABLE'], ['inesperado', 500, 'INTERNAL_ERROR'],
    ]) {
      await t.test(caso, async () => conferirErro(await requisitar(`/sequelize/${caso}`), status, codigo));
    }
  });

  it('seleciona somente campos válidos e permitidos, preservando zero, false e null', async () => {
    const resposta = await enviar('/entrada/7', {
      nome: 'Leitora', data: '2024-02-29', zero: 0, falso: false, nulo: null, senha: segredo,
    });
    assert.equal(resposta.status, 200);
    assert.deepEqual(await resposta.json(), {
      data: { id: 7, nome: 'Leitora', data: '2024-02-29', zero: 0, falso: false, nulo: null },
    });
  });

  it('rejeita IDs, datas impossíveis e campos protegidos antes do handler', async () => {
    for (const id of ['0', '-1', '1e3', '01', '2147483648', encodeURIComponent('1 OR 1=1')]) {
      await conferirErro(await enviar(`/entrada/${id}`, { nome: 'Leitora' }), 422, 'VALIDATION_ERROR');
    }
    await conferirErro(await enviar('/entrada/7', { nome: 'Leitora', data: '2026-02-29' }), 422, 'VALIDATION_ERROR');
    for (const campo of ['perfil', 'sessionVersion', 'senhaHash']) {
      await conferirErro(await enviar('/entrada/7', { nome: 'Leitora', [campo]: segredo }), 422, 'VALIDATION_ERROR');
    }
    await conferirErro(await enviar('/entrada/7', []), 400, 'BAD_REQUEST');
  });

  it('rejeita PATCH vazio e aceita campo permitido explicitamente nulo ou false', async () => {
    await conferirErro(await enviar('/entrada/7', {}, 'PATCH'), 422, 'VALIDATION_ERROR');
    await conferirErro(await enviar('/entrada/7', { perfil: 'ADMIN_CLUBE' }, 'PATCH'), 422, 'VALIDATION_ERROR');
    const resposta = await enviar('/entrada/7', { zero: 0, falso: false, nulo: null }, 'PATCH');
    assert.equal(resposta.status, 200);
    assert.deepEqual(await resposta.json(), { data: { id: 7, zero: 0, falso: false, nulo: null } });
  });

  it('mensagem express-validator dinâmica não devolve a senha enviada', async () => {
    const corpo = await conferirErro(await enviar('/validar-senha', { senha: segredo }), 422, 'VALIDATION_ERROR');
    assert.deepEqual(corpo.error.fields, [{ field: 'senha', message: 'Valor inválido.' }]);
  });

  it('JSON malformado retorna400 sem incluir o corpo recebido no erro', async () => {
    await conferirErro(await requisitar('/json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"senha":"${segredo}`,
    }), 400, 'INVALID_JSON');
  });

  it('application/problem+json usa o mesmo parser e contrato JSON', async () => {
    const resposta = await requisitar('/json', {
      method: 'POST', headers: { 'Content-Type': 'application/problem+json' }, body: '{"ativo":true}',
    });
    assert.equal(resposta.status, 200);
    assert.deepEqual(await resposta.json(), { data: { conteudo: { ativo: true } } });
    await conferirErro(await requisitar('/json', {
      method: 'POST', headers: { 'Content-Type': 'application/problem+json' }, body: '{"ativo":',
    }), 400, 'INVALID_JSON');
  });

  it('charset JSON não suportado recebe400 seguro', async () => {
    await conferirErro(await requisitar('/json', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=iso-8859-1' }, body: '{"ativo":true}',
    }), 400, 'BAD_REQUEST');
  });

  it('encoding não suportado e gzip inválido recebem400 sem detalhes internos', async () => {
    for (const encoding of ['compress', 'gzip']) {
      await conferirErro(await requisitar('/json', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding }, body: '{"ativo":true}',
      }), 400, 'BAD_REQUEST');
    }
  });

  it('limita corpo excessivo em JSON e outros tipos de conteúdo', async () => {
    for (const tipo of ['application/json', 'application/problem+json', 'text/plain']) {
      await conferirErro(await requisitar('/json', {
        method: 'POST', headers: { 'Content-Type': tipo }, body: JSON.stringify({ texto: 'a'.repeat(100 * 1024) }),
      }), 413, 'PAYLOAD_TOO_LARGE');
    }
  });

  it('limite JSON também se aplica ao tamanho depois da descompressão', async () => {
    const conteudo = gzipSync(JSON.stringify({ texto: 'a'.repeat(110 * 1024) }));
    assert.ok(conteudo.length < 100 * 1024);
    await conferirErro(await requisitar('/json', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: conteudo,
    }), 413, 'PAYLOAD_TOO_LARGE');
  });

  it('envia CORS explícito com credenciais e cabeçalhos de segurança', async () => {
    const resposta = await requisitar('/detalhe', { credentials: 'include', headers: { Origin: origemPermitida } });
    assert.equal(resposta.headers.get('access-control-allow-origin'), origemPermitida);
    assert.equal(resposta.headers.get('access-control-allow-credentials'), 'true');
    assert.match(resposta.headers.get('vary'), /Origin/i);
    assert.equal(resposta.headers.get('cache-control'), 'no-store');
    assert.equal(resposta.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(resposta.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(resposta.headers.get('content-security-policy'));
    assert.equal(resposta.headers.get('x-powered-by'), null);
    assert.equal(resposta.headers.get('etag'), null);
    await resposta.json();
  });

  it('preflight permitido retorna204 vazio com credenciais e PATCH disponível', async () => {
    const resposta = await requisitar('/entrada/7', {
      method: 'OPTIONS', headers: {
        Origin: origemPermitida, 'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(resposta.status, 204);
    assert.equal(await resposta.text(), '');
    assert.equal(resposta.headers.get('content-type'), null);
    assert.equal(resposta.headers.get('access-control-allow-origin'), origemPermitida);
    assert.equal(resposta.headers.get('access-control-allow-credentials'), 'true');
    assert.match(resposta.headers.get('access-control-allow-methods'), /PATCH/);
    assert.match(resposta.headers.get('access-control-allow-headers'), /content-type/i);
    assert.match(resposta.headers.get('vary'), /Origin/i);
  });

  it('origem diferente não recebe cabeçalhos de liberação CORS', async () => {
    const resposta = await requisitar('/detalhe', { headers: { Origin: 'https://origem-invalida.example' } });
    assert.equal(resposta.status, 200);
    assert.equal(resposta.headers.get('access-control-allow-origin'), null);
    assert.equal(resposta.headers.get('access-control-allow-credentials'), null);
    assert.match(resposta.headers.get('vary'), /Origin/i);
    await resposta.json();
    const preflight = await requisitar('/entrada/7', {
      method: 'OPTIONS', headers: { Origin: 'https://origem-invalida.example', 'Access-Control-Request-Method': 'PATCH' },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    await preflight.text();
  });

  it('rota inexistente usa o mesmo erro404 seguro', async () => {
    await conferirErro(await requisitar('/rota-inexistente'), 404, 'NOT_FOUND');
  });
});
