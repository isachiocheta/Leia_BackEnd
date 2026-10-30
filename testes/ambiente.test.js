'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { carregarAmbiente } = require('../configuracao/ambiente');

test('usa os padrões locais quando as variáveis estão ausentes', () => {
  assert.deepEqual(carregarAmbiente({}), {
    porta: 3000,
    ambiente: 'development',
    origemPermitida: 'http://localhost:5173',
  });
});

test('aceita a configuração explícita do ambiente', () => {
  assert.deepEqual(
    carregarAmbiente({
      PORT: '8080',
      NODE_ENV: 'production',
      ALLOWED_ORIGIN: 'https://leia.exemplo.com',
    }),
    {
      porta: 8080,
      ambiente: 'production',
      origemPermitida: 'https://leia.exemplo.com',
    },
  );
});

test('aceita os limites válidos de PORT', () => {
  assert.equal(carregarAmbiente({ PORT: '1' }).porta, 1);
  assert.equal(carregarAmbiente({ PORT: '65535' }).porta, 65535);
});

test('rejeita PORT vazia, fora do intervalo ou com formato inválido', async (t) => {
  for (const porta of ['', '0', '-1', '65536', '3000abc', '3000.5', '3e3', ' 3000', '3000 ', '+3000', '999999999999999999999']) {
    await t.test(JSON.stringify(porta), () => {
      assert.throws(() => carregarAmbiente({ PORT: porta }), /PORT/);
    });
  }
});

test('aceita os três valores suportados de NODE_ENV', () => {
  for (const ambiente of ['development', 'test', 'production']) {
    assert.equal(carregarAmbiente({ NODE_ENV: ambiente }).ambiente, ambiente);
  }
});

test('rejeita NODE_ENV vazia ou desconhecida', async (t) => {
  for (const ambiente of ['', 'staging', 'Production', 'teste', ' production', 'production ']) {
    await t.test(JSON.stringify(ambiente), () => {
      assert.throws(() => carregarAmbiente({ NODE_ENV: ambiente }), /NODE_ENV/);
    });
  }
});

test('aceita uma origem HTTP ou HTTPS explícita', () => {
  for (const origem of ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://escola.exemplo.com', 'https://escola.exemplo.com:8443']) {
    assert.equal(carregarAmbiente({ ALLOWED_ORIGIN: origem }).origemPermitida, origem);
  }
});

test('rejeita ALLOWED_ORIGIN inválida ou que não seja uma única origem', async (t) => {
  for (const origem of [
    '',
    '*',
    'null',
    'localhost:5173',
    'ftp://escola.exemplo.com',
    'https://escola.exemplo.com/',
    'https://escola.exemplo.com/caminho',
    'https://escola.exemplo.com?consulta=1',
    'https://escola.exemplo.com#secao',
    'https://usuario:senha@escola.exemplo.com',
    'https://um.exemplo.com,https://outro.exemplo.com',
    ' https://escola.exemplo.com',
  ]) {
    await t.test(JSON.stringify(origem), () => {
      assert.throws(() => carregarAmbiente({ ALLOWED_ORIGIN: origem }), /ALLOWED_ORIGIN/);
    });
  }
});
