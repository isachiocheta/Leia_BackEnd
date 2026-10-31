'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { carregarConfiguracaoSessao, PRAZO_SESSAO_MS } = require('../configuracao/sessao');

const segredo = 'segredo-unitario-de-teste-com-32-bytes';

test('sessão exige segredo do ambiente sem fornecer valor padrão', () => {
  for (const SESSION_SECRET of [undefined, '', 'curto', ' '.repeat(32), 123]) {
    assert.throws(() => carregarConfiguracaoSessao({ SESSION_SECRET }), /SESSION_SECRET/);
  }
});

test('segredo é preservado e medido em bytes UTF-8 sem aparecer nos erros', () => {
  const SESSION_SECRET = ` ${'á'.repeat(16)} `;
  assert.equal(carregarConfiguracaoSessao({ SESSION_SECRET }).segredo, SESSION_SECRET);
  const invalido = 'segredo-invalido';
  assert.throws(() => carregarConfiguracaoSessao({ SESSION_SECRET: invalido }), (erro) => {
    assert.equal(erro.message.includes(invalido), false);
    return true;
  });
});

test('cookie HTTP local é HttpOnly e SameSite Lax com prazo de 30 minutos', () => {
  const configuracao = carregarConfiguracaoSessao({ SESSION_SECRET: segredo, SESSION_COOKIE_SECURE: 'false' });
  assert.equal(configuracao.nomeCookie, 'leia.sid');
  assert.equal(configuracao.prazoMs, 30 * 60 * 1000);
  assert.equal(PRAZO_SESSAO_MS, configuracao.prazoMs);
  assert.deepEqual(configuracao.cookie, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: false, maxAge: PRAZO_SESSAO_MS,
  });
  assert.equal(Object.isFrozen(configuracao), true);
  assert.equal(Object.isFrozen(configuracao.cookie), true);
});

test('produção exige cookie Secure e HTTPS pode habilitá-lo explicitamente', () => {
  for (const SESSION_COOKIE_SECURE of [undefined, 'false']) {
    assert.throws(() => carregarConfiguracaoSessao({
      NODE_ENV: 'production', SESSION_SECRET: segredo, SESSION_COOKIE_SECURE,
    }), /SESSION_COOKIE_SECURE/);
  }
  assert.equal(carregarConfiguracaoSessao({
    NODE_ENV: 'production', SESSION_SECRET: segredo, SESSION_COOKIE_SECURE: 'true',
  }).cookie.secure, true);
});

test('configuração de cookie rejeita booleanos e formatos ambíguos', () => {
  for (const SESSION_COOKIE_SECURE of [true, false, '', 'TRUE', '1', ' true', 'false ']) {
    assert.throws(() => carregarConfiguracaoSessao({ SESSION_SECRET: segredo, SESSION_COOKIE_SECURE }), /SESSION_COOKIE_SECURE/);
  }
});

test('origem HTTPS usa Secure e recusa desabilitar essa proteção', () => {
  const variaveis = { SESSION_SECRET: segredo, ALLOWED_ORIGIN: 'https://escola.exemplo.com' };
  assert.equal(carregarConfiguracaoSessao(variaveis).cookie.secure, true);
  assert.throws(() => carregarConfiguracaoSessao({
    ...variaveis, SESSION_COOKIE_SECURE: 'false',
  }), /SESSION_COOKIE_SECURE/);
});

test('configuração de sessão também rejeita ambiente inválido', () => {
  assert.throws(() => carregarConfiguracaoSessao({ SESSION_SECRET: segredo, NODE_ENV: 'staging' }), /NODE_ENV/);
});
