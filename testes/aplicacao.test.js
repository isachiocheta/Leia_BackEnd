'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { after, before, describe, it } = require('node:test');

process.env.NODE_ENV = 'test';
delete process.env.PORT;
delete process.env.ALLOWED_ORIGIN;

const aplicacao = require('../app');
const banco = require('../database/conexao');

describe('Aplicação HTTP', () => {
  let servidor;
  let endereco;

  before(async () => {
    servidor = aplicacao.listen(0, '127.0.0.1');
    await once(servidor, 'listening');
    endereco = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    if (!servidor) return;

    await new Promise((resolver, rejeitar) => {
      servidor.close((erro) => (erro ? rejeitar(erro) : resolver()));
      servidor.closeAllConnections();
    });
  });

  it('identifica o Leia+ no health com status 200', async () => {
    const resposta = await fetch(`${endereco}/api/health`);

    assert.equal(resposta.status, 200);
    assert.match(resposta.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await resposta.json(), {
      data: { aplicacao: 'Leia+', status: 'ok' },
    });
  });

  it('mantém o health independente do banco indisponível', async (t) => {
    const verificar = t.mock.method(banco, 'verificarConexao', async () => {
      throw new Error('Banco indisponível.');
    });
    const resposta = await fetch(`${endereco}/api/health`);

    assert.equal(resposta.status, 200);
    assert.equal(verificar.mock.callCount(), 0);
    await resposta.json();
  });

  it('retorna prontidão 200 quando a conexão está disponível', async (t) => {
    t.mock.method(banco, 'verificarConexao', async () => {});
    const resposta = await fetch(`${endereco}/api/ready`);

    assert.equal(resposta.status, 200);
    assert.equal(resposta.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await resposta.json(), { data: { aplicacao: 'Leia+', status: 'pronto' } });
  });

  it('retorna prontidão 503 sem expor falhas ou credenciais', async (t) => {
    t.mock.method(banco, 'verificarConexao', async () => {
      throw new Error('postgresql://usuario:segredo@host/banco SELECT detalhe');
    });
    const resposta = await fetch(`${endereco}/api/ready`);

    assert.equal(resposta.status, 503);
    assert.match(resposta.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await resposta.json(), {
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Serviço temporariamente indisponível.' },
    });
  });

  it('retorna 404 em JSON para uma rota inexistente', async () => {
    const resposta = await fetch(`${endereco}/api/rota-inexistente`);

    assert.equal(resposta.status, 404);
    assert.match(resposta.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await resposta.json(), {
      error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' },
    });
  });

  it('retorna 400 em JSON para um corpo JSON malformado', async () => {
    const resposta = await fetch(`${endereco}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"livro":',
    });

    assert.equal(resposta.status, 400);
    assert.match(resposta.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await resposta.json(), {
      error: { code: 'INVALID_JSON', message: 'JSON inválido.' },
    });
  });

  it('retorna 413 em JSON quando o corpo ultrapassa 100 KB', async () => {
    const resposta = await fetch(`${endereco}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: 'a'.repeat(100 * 1024) }),
    });

    assert.equal(resposta.status, 413);
    assert.match(resposta.headers.get('content-type'), /application\/json/);
    const corpo = await resposta.json();
    assert.equal(corpo.error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(typeof corpo.error.message, 'string');
    assert.ok(corpo.error.message.length > 0);
    assert.equal(corpo.error.stack, undefined);
  });

  it('aplica os cabeçalhos de segurança do Helmet', async () => {
    const resposta = await fetch(`${endereco}/api/health`);

    assert.equal(resposta.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(resposta.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(resposta.headers.get('content-security-policy'));
    assert.equal(resposta.headers.get('x-powered-by'), null);
    await resposta.json();
  });

  it('permite a origem local explícita com credenciais', async () => {
    const resposta = await fetch(`${endereco}/api/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });

    assert.equal(resposta.status, 200);
    assert.equal(
      resposta.headers.get('access-control-allow-origin'),
      'http://localhost:5173',
    );
    assert.equal(resposta.headers.get('access-control-allow-credentials'), 'true');
    await resposta.json();
  });

  it('responde ao preflight CORS da origem permitida', async () => {
    const resposta = await fetch(`${endereco}/api/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });

    assert.equal(resposta.status, 204);
    assert.equal(
      resposta.headers.get('access-control-allow-origin'),
      'http://localhost:5173',
    );
    assert.equal(resposta.headers.get('access-control-allow-credentials'), 'true');
    assert.match(resposta.headers.get('access-control-allow-methods'), /POST/);
    assert.match(resposta.headers.get('access-control-allow-headers'), /content-type/i);
    assert.equal(await resposta.text(), '');
  });

  it('não libera a leitura por uma origem diferente da configurada', async () => {
    const origemNaoPermitida = 'https://origem-nao-permitida.example';
    const resposta = await fetch(`${endereco}/api/health`, {
      headers: { Origin: origemNaoPermitida },
    });

    assert.notEqual(
      resposta.headers.get('access-control-allow-origin'),
      origemNaoPermitida,
    );
    assert.notEqual(resposta.headers.get('access-control-allow-origin'), '*');
    assert.equal(resposta.headers.get('access-control-allow-origin'), null);
    assert.equal(resposta.headers.get('access-control-allow-credentials'), null);
    assert.match(resposta.headers.get('vary'), /Origin/i);
    await resposta.json();
  });

  it('não publica rotas artificiais de erro ou recursos ainda não implementados', async () => {
    for (const rota of ['/api/erro', '/api/erros/500', '/api/teste/erro', '/api/ciclos', '/api/encontros']) {
      const resposta = await fetch(`${endereco}${rota}`);
      assert.equal(resposta.status, 404);
      assert.deepEqual(await resposta.json(), {
        error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' },
      });
    }
  });
});
