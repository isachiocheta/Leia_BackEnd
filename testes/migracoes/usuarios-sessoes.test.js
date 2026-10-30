'use strict';

const assert = require('node:assert/strict');
const caminho = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');
const { criarConexao } = require('../../database/conexao');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

validarBancoTeste(process.env);
const diretorioBackend = caminho.resolve(__dirname, '../..');
const migracaoAnterior = '20261030000000-criar-dominio.js';
const migracaoUsuarios = '20261030010000-completar-usuarios.js';
const migracaoSessoes = '20261030011000-criar-sessoes.js';
const migracoesConhecidas = [migracaoAnterior, migracaoUsuarios, migracaoSessoes];
let conexao;

function executarCli(comando, argumentos = [], codigo = 0) {
  validarDestinoTeste(conexao);
  const resultado = spawnSync(process.execPath, [
    caminho.join(diretorioBackend, 'database/executar-cli.js'), comando, ...argumentos,
  ], {
    cwd: diretorioBackend,
    env: process.env,
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });

  assert.ifError(resultado.error);
  assert.equal(resultado.signal, null, resultado.stderr);
  assert.equal(resultado.status, codigo, `${resultado.stdout}\n${resultado.stderr}`);
}

async function migracoesAplicadas() {
  const [linhas] = await conexao.query('SELECT name FROM sequelize_meta ORDER BY name');
  return linhas.map((linha) => linha.name);
}

async function conferirEtapa03() {
  const usuarios = await conexao.getQueryInterface().describeTable('usuarios');
  assert.equal(usuarios.nome.type, 'CHARACTER VARYING(100)');
  for (const coluna of ['senha_hash', 'situacao', 'session_version']) {
    assert.equal(usuarios[coluna].allowNull, false);
  }
  const sessoes = await conexao.getQueryInterface().describeTable('sessoes');
  assert.deepEqual(Object.keys(sessoes).sort(), ['expire', 'sess', 'sid']);
  assert.deepEqual(await migracoesAplicadas(), migracoesConhecidas);
}

before(async () => {
  conexao = criarConexao();
  validarDestinoTeste(conexao);
  await conexao.authenticate();

  // O ciclo altera o schema: além das guardas do destino, exige banco sem dados.
  // Recusa também tabelas/migrations de outras etapas antes de qualquer rollback.
  const tabelas = await conexao.getQueryInterface().showAllTables();
  const conhecidas = new Set([
    'usuarios', 'generos', 'livros', 'ciclos_leitura', 'encontros',
    'participacoes_leitura', 'inscricoes_encontro', 'sessoes', 'sequelize_meta',
  ]);
  assert.ok(tabelas.every((tabela) => conhecidas.has(tabela)), 'Use um banco de teste exclusivo para este ciclo.');

  for (const tabela of tabelas.filter((nome) => nome !== 'sequelize_meta')) {
    const [linhas] = await conexao.query(`SELECT 1 FROM "${tabela}" LIMIT 1`);
    assert.equal(linhas.length, 0, 'O teste de migrations exige tabelas sem dados.');
  }

  if (tabelas.includes('sequelize_meta')) {
    assert.ok((await migracoesAplicadas()).every((nome) => migracoesConhecidas.includes(nome)));
  }
});

after(async () => {
  if (conexao) await conexao.close();
});

test('migrations de usuários e sessões executam up, down e up sem editar a etapa anterior', { timeout: 45_000 }, async () => {
  executarCli('db:migrate', ['--to', migracaoAnterior]);
  let aplicadas = await migracoesAplicadas();

  // Permite repetir o teste após um ciclo já concluído, sempre sem dados.
  while (aplicadas.length > 1) {
    executarCli('db:migrate:undo');
    aplicadas = await migracoesAplicadas();
  }
  assert.deepEqual(aplicadas, [migracaoAnterior]);
  const estruturaAnterior = await conexao.getQueryInterface().describeTable('usuarios');

  // Sem hashes legados, a evolução deve falhar atomicamente, sem inventar senha.
  validarDestinoTeste(conexao);
  const [legados] = await conexao.query(`
    INSERT INTO usuarios (nome, email, criado_em, atualizado_em)
    VALUES ('Leitor legado', 'legado@escola.exemplo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING id
  `);

  try {
    executarCli('db:migrate', [], 1);
    assert.deepEqual(await conexao.getQueryInterface().describeTable('usuarios'), estruturaAnterior);
    assert.deepEqual(await migracoesAplicadas(), [migracaoAnterior]);
    const [mantidos] = await conexao.query('SELECT id FROM usuarios WHERE id = $1', { bind: [legados[0].id] });
    assert.equal(mantidos.length, 1);
  } finally {
    validarDestinoTeste(conexao);
    await conexao.query('DELETE FROM usuarios WHERE id = $1', { bind: [legados[0].id] });
  }

  executarCli('db:migrate');
  await conferirEtapa03();

  executarCli('db:migrate:undo');
  assert.ok(!(await conexao.getQueryInterface().showAllTables()).includes('sessoes'));
  executarCli('db:migrate:undo');
  assert.deepEqual(await conexao.getQueryInterface().describeTable('usuarios'), estruturaAnterior);
  assert.deepEqual(await migracoesAplicadas(), [migracaoAnterior]);

  executarCli('db:migrate');
  await conferirEtapa03();
});
