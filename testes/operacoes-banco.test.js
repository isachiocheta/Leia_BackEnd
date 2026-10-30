'use strict';

const assert = require('node:assert/strict');
const caminho = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { validarDestinoTeste, validarOperacaoCli } = require('../configuracao/operacoes-banco');
const migracao = require('../database/migracoes/20261030000000-criar-dominio');

const criarParser = require(require.resolve('yargs/yargs', {
  paths: [caminho.dirname(require.resolve('sequelize-cli/package.json'))],
}));

const diretorioBackend = caminho.resolve(__dirname, '..');
const ambienteSeguro = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://usuario:senha@localhost:5432/leia_mais',
  TEST_DATABASE_URL: 'postgresql://usuario:senha@localhost:5432/leia_mais_test',
};

function conexaoDeTeste(alteracoes = {}) {
  return {
    config: { database: 'leia_mais_test', host: 'localhost', port: 5432, ...alteracoes },
    getDialect: () => 'postgres',
  };
}

function interpretar(argumentos) {
  return criarParser(argumentos)
    .exitProcess(false)
    .help(false)
    .version(false)
    .command('db:drop', 'Remove o banco')
    .option('env', { type: 'string' })
    .option('url', { type: 'string' })
    .option('config', { type: 'string' })
    .option('options-path', { type: 'string' })
    .strict()
    .fail((mensagem, erro) => { throw erro || new Error(mensagem); })
    .parse();
}

async function comAmbiente(variaveis, executar) {
  const anteriores = {};

  for (const nome of Object.keys(variaveis)) {
    anteriores[nome] = process.env[nome];
    if (variaveis[nome] === undefined) delete process.env[nome];
    else process.env[nome] = variaveis[nome];
  }

  try {
    return await executar();
  } finally {
    for (const [nome, valor] of Object.entries(anteriores)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  }
}

test('permite operações destrutivas somente com ambiente e banco de teste validados', () => {
  const comandos = [
    'db:drop', 'db:migrate:undo', 'db:migrate:undo:all',
    'db:seed', 'db:seed:all', 'db:seed:undo', 'db:seed:undo:all',
    'db:migrate:schema:timestamps:add',
  ];

  for (const comando of comandos) {
    assert.doesNotThrow(() => validarOperacaoCli([comando], ambienteSeguro));

    for (const ambiente of [undefined, 'development', 'production']) {
      assert.throws(
        () => validarOperacaoCli([comando], { ...ambienteSeguro, NODE_ENV: ambiente }),
        /NODE_ENV/,
      );
    }

    assert.throws(
      () => validarOperacaoCli([comando], { ...ambienteSeguro, TEST_DATABASE_URL: undefined }),
      /TEST_DATABASE_URL/,
    );
    assert.throws(
      () => validarOperacaoCli([comando], {
        ...ambienteSeguro, DATABASE_URL: ambienteSeguro.TEST_DATABASE_URL,
      }),
      /diferente/,
    );
  }
});

test('permite migração e consulta de estado no ambiente normal', () => {
  for (const ambiente of ['development', 'production']) {
    for (const comando of ['db:migrate', 'db:migrate:status']) {
      assert.doesNotThrow(() => validarOperacaoCli([comando], { ...ambienteSeguro, NODE_ENV: ambiente }));
    }
  }
});

test('bloqueia substituição de URL, configuração e arquivo de opções', () => {
  for (const opcao of ['--url', '--config', '--options-path', '--optionsPath']) {
    for (const argumentos of [
      ['db:drop', opcao, 'destino-externo'],
      ['db:drop', `${opcao}=destino-externo`],
      [opcao, 'destino-externo', 'db:migrate'],
    ]) {
      assert.throws(() => validarOperacaoCli(argumentos, ambienteSeguro), /sem sobrescrever/);
    }
  }
});

test('exige que --env coincida com NODE_ENV nas duas sintaxes do CLI', () => {
  for (const argumentos of [
    ['db:drop', '--env', 'test'],
    ['db:drop', '--env=test'],
    ['--env', 'test', 'db:drop'],
  ]) {
    assert.doesNotThrow(() => validarOperacaoCli(argumentos, ambienteSeguro));
  }

  for (const argumentos of [
    ['db:drop', '--env', 'production'],
    ['db:drop', '--env=development'],
    ['db:drop', '--env'],
    ['db:drop', '--env=test', '--env=production'],
  ]) {
    assert.throws(() => validarOperacaoCli(argumentos, ambienteSeguro), /--env/);
  }
});

test('cobre a expansão camelCase aceita pelo parser real do sequelize-cli', () => {
  for (const opcao of ['--options-path', '--optionsPath']) {
    const argumentos = ['db:drop', opcao, 'arquivo-externo.js'];
    const resultado = interpretar(argumentos);

    assert.equal(resultado.optionsPath, 'arquivo-externo.js');
    assert.equal(resultado['options-path'], 'arquivo-externo.js');
    assert.throws(() => validarOperacaoCli(argumentos, ambienteSeguro), /sem sobrescrever/);
  }
});

test('abreviações de opções não são aliases no parser estrito do sequelize-cli', () => {
  for (const opcao of ['--ur', '--conf', '--confi', '--optionsP', '-u', '-c', '-e']) {
    assert.throws(() => interpretar(['db:drop', opcao, 'externo']), /Unknown argument/);
  }
});

test('wrapper bloqueia options-path antes de o CLI tentar carregar outro arquivo', () => {
  for (const opcao of ['--options-path', '--optionsPath']) {
    const resultado = spawnSync(process.execPath, [
      caminho.join(diretorioBackend, 'database/executar-cli.js'),
      'db:drop', opcao, caminho.join(diretorioBackend, 'arquivo-inexistente-nao-carregar.js'),
    ], {
      cwd: diretorioBackend,
      env: { ...process.env, ...ambienteSeguro },
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
    });

    assert.ifError(resultado.error);
    assert.equal(resultado.signal, null);
    assert.equal(resultado.status, 1);
    assert.match(resultado.stderr, /Comando de banco bloqueado/);
    assert.doesNotMatch(`${resultado.stdout}${resultado.stderr}`, /Cannot find module|ENOENT|Sequelize CLI/);
  }
});

test('valida o destino efetivo por banco, host, porta e dialeto', () => {
  assert.equal(validarDestinoTeste(conexaoDeTeste(), ambienteSeguro).nomeBanco, 'leia_mais_test');
  assert.doesNotThrow(() => validarDestinoTeste(conexaoDeTeste({ port: '5432', host: 'LOCALHOST' }), ambienteSeguro));

  for (const alteracoes of [
    { database: 'leia_mais' },
    { database: undefined },
    { host: 'outro-servidor' },
    { host: undefined },
    { port: 6543 },
    { port: undefined },
    { port: null },
    { port: 0 },
    { port: -1 },
    { port: 65536 },
    { port: 5432.5 },
  ]) {
    assert.throws(() => validarDestinoTeste(conexaoDeTeste(alteracoes), ambienteSeguro), /conexão diferente/);
  }

  assert.throws(
    () => validarDestinoTeste({ ...conexaoDeTeste(), getDialect: () => 'mysql' }, ambienteSeguro),
    /conexão diferente/,
  );
  assert.throws(
    () => validarDestinoTeste({ ...conexaoDeTeste(), getDialect: undefined }, ambienteSeguro),
    /conexão diferente/,
  );
});

test('compara host IPv6 com os colchetes da URL normalizados', () => {
  assert.doesNotThrow(() => validarDestinoTeste(conexaoDeTeste({ host: '::1' }), {
    ...ambienteSeguro,
    TEST_DATABASE_URL: 'postgresql://usuario:senha@[::1]:5432/leia_mais_test',
  }));
});

test('rollback direto bloqueia banco normal antes de iniciar transação ou apagar tabelas', async () => {
  let transacoes = 0;
  let exclusoes = 0;
  const conexao = conexaoDeTeste({ database: 'leia_mais' });
  conexao.transaction = async () => { transacoes += 1; };
  const queryInterface = {
    sequelize: conexao,
    dropTable: async () => { exclusoes += 1; },
  };

  await comAmbiente(ambienteSeguro, async () => {
    await assert.rejects(migracao.down(queryInterface), /conexão diferente/);
  });

  assert.equal(transacoes, 0);
  assert.equal(exclusoes, 0);
});

test('rollback direto também exige NODE_ENV=test antes de tocar no banco', async () => {
  let transacoes = 0;
  const conexao = conexaoDeTeste();
  conexao.transaction = async () => { transacoes += 1; };

  await comAmbiente({ ...ambienteSeguro, NODE_ENV: 'production' }, async () => {
    await assert.rejects(migracao.down({ sequelize: conexao }), /NODE_ENV/);
  });

  assert.equal(transacoes, 0);
});
