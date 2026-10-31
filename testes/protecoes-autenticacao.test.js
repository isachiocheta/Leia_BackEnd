'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { criarLimiteLogin } = require('../autenticacao/limite-login');
const { obterTokenCsrf, protegerCsrf } = require('../autenticacao/csrf');
const { protegerRota, exigirPerfil } = require('../autenticacao/rotas');

function aplicar(intermediarios, requisicao) {
  const resposta = { set() {} };
  let resultado;
  let indice = 0;
  function proximo(erro) {
    if (erro) { resultado = erro; return; }
    if (indice < intermediarios.length) intermediarios[indice++](requisicao, resposta, proximo);
  }
  proximo();
  return resultado;
}

test('CSRF usa token aleatório associado à sessão, sem reutilizar outra sessão', () => {
  const primeira = {};
  const segunda = {};
  const token = obterTokenCsrf(primeira);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(obterTokenCsrf(primeira), token);
  assert.notEqual(obterTokenCsrf(segunda), token);
  const requisicao = (valor) => ({ method: 'POST', session: primeira, get: () => valor });
  assert.equal(aplicar([protegerCsrf], requisicao(token)), undefined);
  for (const valor of [undefined, '', 'x'.repeat(64), obterTokenCsrf(segunda), token.toUpperCase()]) {
    assert.equal(aplicar([protegerCsrf], requisicao(valor)).status, 403);
  }
  assert.equal(aplicar([protegerCsrf], { method: 'GET' }), undefined);
});

test('proteção exige autenticação e perfil antes de ler o token CSRF', () => {
  const semToken = () => { throw new Error('CSRF não deveria ter sido consultado.'); };
  const rotas = protegerRota('ADMIN_CLUBE');
  assert.equal(aplicar(rotas, { isAuthenticated: () => false, get: semToken }).status, 401);
  assert.equal(aplicar(rotas, { isAuthenticated: () => true, user: { perfil: 'LEITOR' }, get: semToken }).status, 403);
  const sessao = {};
  const token = obterTokenCsrf(sessao);
  assert.equal(aplicar(rotas, {
    method: 'POST', isAuthenticated: () => true, user: { perfil: 'ADMIN_CLUBE' },
    session: sessao, get: () => token,
  }), undefined);
  assert.throws(() => exigirPerfil('visitante'), TypeError);
});

test('limite de login é por IP e janela fixa, com Retry-After e liberação ao vencer', () => {
  let instante = 1000;
  const limitar = criarLimiteLogin({ maximo: 2, janelaMs: 15000, agora: () => instante });
  const cabecalhos = {};
  const resposta = { set: (chave, valor) => { cabecalhos[chave] = valor; } };
  const aplicarLimite = (ip) => {
    let recebido;
    limitar({ ip, socket: {} }, resposta, (erro) => { recebido = erro; });
    return recebido;
  };
  assert.equal(aplicarLimite('127.0.0.1'), undefined);
  assert.equal(aplicarLimite('127.0.0.1'), undefined);
  instante += 1000;
  assert.equal(aplicarLimite('127.0.0.1').codigo, 'TOO_MANY_REQUESTS');
  assert.equal(cabecalhos['Retry-After'], '14');
  assert.equal(aplicarLimite('127.0.0.2'), undefined);
  instante = 16000;
  assert.equal(aplicarLimite('127.0.0.1'), undefined);
  assert.throws(() => criarLimiteLogin({ maximo: 0 }), TypeError);
});
