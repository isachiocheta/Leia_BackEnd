'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const caminho = require('node:path');
const { lerContrato, conferirRotas, criarValidadorTrocas } = require('../contracts/validar');

test('YAML/OpenAPI é válido e corresponde às 38 operações reais, sem banco ou listen', async () => {
  const contrato = await lerContrato(); assert.equal(conferirRotas(contrato), 38);
  assert.equal(contrato.components.securitySchemes.CookieSessao.name, 'leia.sid');
  assert.equal(contrato.components.securitySchemes.TokenCsrf.name, 'X-CSRF-Token');
  assert.deepEqual(contrato.paths['/api/dashboard/me'].get['x-perfis'], ['LEITOR']);
});

test('verificação detecta operação removida e endpoint inventado no contrato', async () => {
  const contrato = await lerContrato(); delete contrato.paths['/api/me'].patch;
  assert.throws(() => conferirRotas(contrato), /divergem/);
  contrato.paths['/inventada'] = { get: { responses: {} } }; assert.throws(() => conferirRotas(contrato), /divergem/);
});

test('validação de respostas contratuais recusa números em strings e campos não previstos', async () => {
  const { conferir } = criarValidadorTrocas(await lerContrato());
  const resposta = { status: 200, headers: { 'content-type': 'application/json' }, body: { data: [], meta: { page: 1, pageSize: 12, total: '0' } } };
  assert.throws(() => conferir('get', '/api/generos', resposta), /Contrato divergente/);
  resposta.body.meta.total = 0; conferir('get', '/api/generos', resposta);
  resposta.body.senhaHash = 'valor que não deve ser serializado'; assert.throws(() => conferir('get', '/api/generos', resposta), /Contrato divergente/);
});

test('--help dos comandos operacionais funciona sem credenciais nem conexão de banco', () => {
  const ambiente = { ...process.env };
  for (const nome of Object.keys(ambiente)) if (/^(ADMIN_|DEMO_|SESSION_)|^(DATABASE_URL|TEST_DATABASE_URL)$/.test(nome)) delete ambiente[nome];
  for (const arquivo of ['server.js', 'database/bootstrap-administrativo.js', 'database/carregar-demonstracao.js', 'database/exportar-sql.js', 'verificacao/verificar.js', 'verificacao/instalacao.js']) {
    const resultado = spawnSync(process.execPath, [arquivo, '--help'], { cwd: caminho.resolve(__dirname, '..'), env: ambiente, encoding: 'utf8', timeout: 10000 });
    assert.ifError(resultado.error); assert.equal(resultado.status, 0, arquivo); assert.match(resultado.stdout, /Leia\+/);
  }
});
