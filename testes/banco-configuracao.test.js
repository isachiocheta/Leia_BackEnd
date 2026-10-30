'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { carregarConfiguracaoBanco, validarBancoTeste } = require('../configuracao/banco');

const bancoNormal = 'postgresql://leia:senha@localhost:5432/leia_mais';
const bancoTeste = 'postgresql://leia:senha@localhost:5432/leia_mais_teste';

function ambienteTeste(variaveis = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: bancoNormal,
    TEST_DATABASE_URL: bancoTeste,
    ...variaveis,
  };
}

test('seleciona DATABASE_URL em desenvolvimento por padrão e em produção', () => {
  for (const ambiente of [undefined, 'development', 'production']) {
    const configuracao = carregarConfiguracaoBanco({ NODE_ENV: ambiente, DATABASE_URL: bancoNormal });

    assert.equal(configuracao.url, bancoNormal);
    assert.equal(configuracao.nomeBanco, 'leia_mais');
    assert.equal(configuracao.ambiente, ambiente ?? 'development');
    assert.equal(configuracao.opcoes.dialect, 'postgres');
    assert.equal(configuracao.opcoes.logging, false);
    assert.equal(configuracao.opcoes.dialectOptions.connectionTimeoutMillis, 3000);
    assert.equal(configuracao.opcoes.dialectOptions.query_timeout, 3000);
  }
});

test('seleciona exclusivamente TEST_DATABASE_URL em teste', () => {
  const configuracao = carregarConfiguracaoBanco(ambienteTeste());

  assert.equal(configuracao.url, bancoTeste);
  assert.equal(configuracao.nomeBanco, 'leia_mais_teste');
  assert.equal(configuracao.ambiente, 'test');
});

test('aceita PostgreSQL com nomes explícitos, nomes codificados e sslmode', () => {
  for (const endereco of [
    'postgres://usuario:senha@127.0.0.1:5432/leia-mais',
    'postgresql://usuario:senha@localhost/leia%5fmais',
    'postgresql://usuario:senha@[::1]:5432/leia_mais',
    'postgresql://usuario:senha@localhost/leia_mais?sslmode=require',
    'postgresql://usuario:senha@localhost/leia_mais?sslmode=verify-full',
  ]) {
    assert.equal(carregarConfiguracaoBanco({ DATABASE_URL: endereco }).url, endereco);
  }
});

test('rejeita NODE_ENV ausente na proteção destrutiva, vazio ou desconhecido', () => {
  for (const ambiente of [undefined, '', null, 'development', 'production', 'staging', 'TEST']) {
    assert.throws(() => validarBancoTeste(ambienteTeste({ NODE_ENV: ambiente })), /NODE_ENV/);
  }

  for (const ambiente of ['', null, 'staging', 'TEST']) {
    assert.throws(() => carregarConfiguracaoBanco({ NODE_ENV: ambiente, DATABASE_URL: bancoNormal }), /NODE_ENV/);
  }
});

test('não usa o banco normal quando TEST_DATABASE_URL está ausente ou vazia', () => {
  for (const endereco of [undefined, '', null]) {
    assert.throws(
      () => carregarConfiguracaoBanco(ambienteTeste({ TEST_DATABASE_URL: endereco })),
      /TEST_DATABASE_URL/,
    );
  }
});

test('exige DATABASE_URL também em testes para validar a separação dos bancos', () => {
  assert.throws(() => validarBancoTeste(ambienteTeste({ DATABASE_URL: undefined })), /DATABASE_URL/);
  assert.throws(() => carregarConfiguracaoBanco({}), /DATABASE_URL/);
});

test('rejeita URLs sem banco, outro protocolo, caminhos e credenciais malformadas', async (t) => {
  for (const endereco of [
    '',
    'leia_mais',
    'mysql://usuario:senha@localhost/leia_mais',
    'postgresql:///leia_mais',
    'postgresql://localhost',
    'postgresql://localhost/',
    'postgresql://localhost/leia_mais/outra',
    'postgresql://localhost/leia%2fmais',
    'postgresql://localhost/leia%5cmais',
    'postgresql://localhost/leia%252fmais',
    'postgresql://localhost/%ZZ',
    'postgresql://localhost/leia_mais#fragmento',
    'postgresql://localhost/leia_mais ',
    'postgresql://usuario:%ZZ@localhost/leia_mais',
    'postgresql://usuario:senha%00@localhost/leia_mais',
    `postgresql://localhost/${'a'.repeat(64)}`,
  ]) {
    await t.test(endereco || 'vazia', () => {
      assert.throws(() => carregarConfiguracaoBanco({ DATABASE_URL: endereco }), /DATABASE_URL/);
    });
  }
});

test('exige sufixo identificável no nome do banco de teste', () => {
  for (const nome of ['leia_mais', 'postgres', 'template1', 'teste_leia', 'leia_test_producao']) {
    assert.throws(
      () => validarBancoTeste(ambienteTeste({ TEST_DATABASE_URL: `postgresql://localhost/${nome}` })),
      /sufixo/,
    );
  }

  for (const nome of ['leia_test', 'leia_teste']) {
    assert.equal(
      validarBancoTeste(ambienteTeste({ TEST_DATABASE_URL: `postgresql://localhost/${nome}` })).nomeBanco,
      nome,
    );
  }
});

test('rejeita o mesmo banco apesar de alias, porta, credenciais ou nome codificado', () => {
  const normal = 'postgresql://normal:senha@localhost:5432/leia_test';

  for (const endereco of [
    normal,
    'postgresql://outro:outra@127.0.0.1:6543/leia_test',
    'postgresql://outro@banco.exemplo/leia%5ftest',
    'postgresql://outro@banco.exemplo/LEIA_TEST',
  ]) {
    assert.throws(
      () => validarBancoTeste(ambienteTeste({ DATABASE_URL: normal, TEST_DATABASE_URL: endereco })),
      /diferente/,
    );
  }
});

test('bloqueia parâmetros que podem substituir o destino validado', () => {
  for (const parametros of [
    'database=leia_mais',
    'dbname=leia_mais',
    '%64atabase=leia_mais',
    'host=outro-servidor',
    'port=6543',
    'user=outro',
    'sslmode=require&database=leia_mais',
    'sslmode=require&sslmode=disable',
    'sslmode=desconhecido',
    'options=-csearch_path%3Doutro',
  ]) {
    assert.throws(
      () => validarBancoTeste(ambienteTeste({ TEST_DATABASE_URL: `${bancoTeste}?${parametros}` })),
      /TEST_DATABASE_URL/,
    );
  }
});

test('mensagens de configuração não revelam URL, usuário ou senha', () => {
  const segredo = 'postgresql://usuario_reservado:senha_reservada@localhost/leia_mais?database=producao';

  assert.throws(() => carregarConfiguracaoBanco({ DATABASE_URL: segredo }), (erro) => {
    assert.match(erro.message, /DATABASE_URL/);
    assert.doesNotMatch(erro.message, /usuario_reservado|senha_reservada|postgresql:|localhost/);
    return true;
  });
});
