'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const caminho = require('node:path');
const { test } = require('node:test');

const diretorioBackend = caminho.resolve(__dirname, '..');
const caminhoAplicacao = caminho.join(diretorioBackend, 'app.js');
const caminhoServidor = caminho.join(diretorioBackend, 'server.js');

function ambienteDeTeste(variaveis = {}) {
  const ambiente = { ...process.env, NODE_ENV: 'test' };
  delete ambiente.PORT;
  delete ambiente.ALLOWED_ORIGIN;
  return { ...ambiente, ...variaveis };
}

function executar(argumentos, variaveis) {
  return spawnSync(process.execPath, argumentos, {
    cwd: diretorioBackend,
    env: ambienteDeTeste(variaveis),
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
}

test('importar app.js não abre porta nem registra sinais de encerramento', () => {
  const programa = `
    const assert = require('node:assert/strict');
    const net = require('node:net');
    const sinaisAntes = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
    net.Server.prototype.listen = () => {
      throw new Error('A importação tentou abrir uma porta.');
    };
    const aplicacao = require(${JSON.stringify(caminhoAplicacao)});
    assert.equal(typeof aplicacao, 'function');
    assert.equal(typeof aplicacao.use, 'function');
    assert.equal(process.listenerCount('SIGINT'), sinaisAntes.SIGINT);
    assert.equal(process.listenerCount('SIGTERM'), sinaisAntes.SIGTERM);
  `;

  const resultado = executar(['--eval', programa]);

  assert.ifError(resultado.error);
  assert.equal(resultado.signal, null, resultado.stderr);
  assert.equal(resultado.status, 0, resultado.stderr);
});

test('importar app.js rejeita configuração inválida antes de abrir porta', () => {
  const programa = `
    const assert = require('node:assert/strict');
    const net = require('node:net');
    net.Server.prototype.listen = () => {
      throw new Error('A importação tentou abrir uma porta.');
    };
    assert.throws(() => require(${JSON.stringify(caminhoAplicacao)}), /NODE_ENV/);
  `;

  const resultado = executar(['--eval', programa], { NODE_ENV: 'invalido' });

  assert.ifError(resultado.error);
  assert.equal(resultado.status, 0, resultado.stderr);
});

test('server.js falha com código 1 quando o ambiente é inválido', async (t) => {
  for (const [variavel, valor] of [['NODE_ENV', 'invalido'], ['PORT', '3000abc'], ['ALLOWED_ORIGIN', '*']]) {
    await t.test(variavel, () => {
      const resultado = executar([caminhoServidor], { [variavel]: valor });

      assert.ifError(resultado.error);
      assert.equal(resultado.signal, null, resultado.stderr);
      assert.equal(resultado.status, 1, resultado.stderr);
      assert.match(resultado.stderr, new RegExp(variavel));
    });
  }
});
