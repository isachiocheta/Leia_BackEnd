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
const migracaoGeneros = '20261030020000-ajustar-generos.js';
const migracaoLivros = '20261030021000-completar-livros.js';
const migracaoCiclos = '20261030030000-completar-ciclos-leitura.js';
const migracoesConhecidas = [migracaoAnterior, migracaoUsuarios, migracaoSessoes, migracaoGeneros, migracaoLivros, migracaoCiclos];
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

async function conferirSchemaAtual() {
  const usuarios = await conexao.getQueryInterface().describeTable('usuarios');
  assert.equal(usuarios.nome.type, 'CHARACTER VARYING(100)');
  for (const coluna of ['senha_hash', 'situacao', 'session_version']) {
    assert.equal(usuarios[coluna].allowNull, false);
  }
  const sessoes = await conexao.getQueryInterface().describeTable('sessoes');
  assert.deepEqual(Object.keys(sessoes).sort(), ['expire', 'sess', 'sid']);
  const generos = await conexao.getQueryInterface().describeTable('generos');
  assert.equal(generos.nome.type, 'CHARACTER VARYING(60)');
  const livros = await conexao.getQueryInterface().describeTable('livros');
  assert.equal(livros.titulo.type, 'CHARACTER VARYING(160)');
  assert.equal(livros.autor.type, 'CHARACTER VARYING(120)');
  assert.equal(livros.total_paginas.allowNull, false);
  assert.equal(livros.total_paginas.defaultValue, null);
  assert.equal(livros.autor_informado, undefined);
  for (const campo of ['ano_publicacao', 'descricao', 'capa_url']) {
    assert.equal(livros[campo].allowNull, true);
  }
  const ciclos = await conexao.getQueryInterface().describeTable('ciclos_leitura');
  assert.equal(ciclos.nome.type, 'CHARACTER VARYING(120)');
  assert.equal(ciclos.nome.allowNull, false);
  assert.equal(ciclos.nome.defaultValue, null);
  assert.equal(ciclos.orientacoes.allowNull, true);
  assert.equal(ciclos.data_inicio.type, 'DATE');
  assert.equal(ciclos.data_fim.type, 'DATE');
  assert.equal(ciclos.situacao.allowNull, false);
  assert.match(String(ciclos.situacao.defaultValue), /PLANEJADO/);
  const [indices] = await conexao.query(`
    SELECT i.indisunique, pg_get_expr(i.indexprs, i.indrelid) AS expressao,
           pg_get_expr(i.indpred, i.indrelid) AS predicado
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'ciclos_leitura_unico_em_andamento'
       AND i.indrelid = 'ciclos_leitura'::regclass
  `);
  assert.equal(indices.length, 1);
  assert.equal(indices[0].indisunique, true);
  assert.equal(indices[0].expressao, '1');
  assert.match(indices[0].predicado, /situacao.*EM_ANDAMENTO/);
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

test('migrations executam up, down em ordem inversa e up sem editar as anteriores', { timeout: 60_000 }, async () => {
  executarCli('db:migrate', ['--to', migracaoAnterior]);
  let aplicadas = await migracoesAplicadas();

  // Permite repetir o teste após um ciclo já concluído, sempre sem dados.
  while (aplicadas.length > 1) {
    executarCli('db:migrate:undo');
    aplicadas = await migracoesAplicadas();
  }
  assert.deepEqual(aplicadas, [migracaoAnterior]);
  const estruturaAnterior = await conexao.getQueryInterface().describeTable('usuarios');
  const generosAnteriores = await conexao.getQueryInterface().describeTable('generos');
  const livrosAnteriores = await conexao.getQueryInterface().describeTable('livros');
  const ciclosAnteriores = await conexao.getQueryInterface().describeTable('ciclos_leitura');

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

  executarCli('db:migrate', ['--to', migracaoSessoes]);
  validarDestinoTeste(conexao);
  const [generos] = await conexao.query(`
    INSERT INTO generos (nome, criado_em, atualizado_em)
    VALUES ('Gênero legado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `);
  const [livrosLegados] = await conexao.query(`
    INSERT INTO livros (titulo, autor_informado, genero_id, criado_em, atualizado_em)
    VALUES ('Obra legada', 'Autor preservado', $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [generos[0].id] });

  try {
    executarCli('db:migrate', [], 1);
    assert.deepEqual(await conexao.getQueryInterface().describeTable('livros'), livrosAnteriores);
    assert.deepEqual(await migracoesAplicadas(), migracoesConhecidas.slice(0, 4));
    const [mantidos] = await conexao.query('SELECT autor_informado FROM livros WHERE id = $1', {
      bind: [livrosLegados[0].id],
    });
    assert.equal(mantidos[0].autor_informado, 'Autor preservado');
  } finally {
    validarDestinoTeste(conexao);
    await conexao.query('DELETE FROM livros WHERE id = $1', { bind: [livrosLegados[0].id] });
    await conexao.query('DELETE FROM generos WHERE id = $1', { bind: [generos[0].id] });
  }

  executarCli('db:migrate', ['--to', migracaoLivros]);
  validarDestinoTeste(conexao);
  const [generosCiclo] = await conexao.query(`
    INSERT INTO generos (nome, criado_em, atualizado_em)
    VALUES ('Gênero do ciclo legado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `);
  const [obras] = await conexao.query(`
    INSERT INTO livros (titulo, autor, genero_id, total_paginas, criado_em, atualizado_em)
    VALUES ('Obra do ciclo', 'Autor', $1, 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [generosCiclo[0].id] });
  const [legadosCiclo] = await conexao.query(`
    INSERT INTO ciclos_leitura (livro_id, data_inicio, data_fim, criado_em, atualizado_em)
    VALUES ($1, '2026-10-01', '2026-10-31', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [obras[0].id] });

  try {
    executarCli('db:migrate', [], 1);
    assert.deepEqual(await conexao.getQueryInterface().describeTable('ciclos_leitura'), ciclosAnteriores);
    assert.deepEqual(await migracoesAplicadas(), migracoesConhecidas.slice(0, 5));
    const [mantidos] = await conexao.query('SELECT data_inicio::text FROM ciclos_leitura WHERE id = $1', {
      bind: [legadosCiclo[0].id],
    });
    assert.equal(mantidos[0].data_inicio, '2026-10-01');
  } finally {
    validarDestinoTeste(conexao);
    await conexao.query('DELETE FROM ciclos_leitura WHERE id = $1', { bind: [legadosCiclo[0].id] });
    await conexao.query('DELETE FROM livros WHERE id = $1', { bind: [obras[0].id] });
    await conexao.query('DELETE FROM generos WHERE id = $1', { bind: [generosCiclo[0].id] });
  }

  executarCli('db:migrate');
  await conferirSchemaAtual();

  // Ciclos são revertidos antes do catálogo, preservando as FKs e datas originais.
  executarCli('db:migrate:undo');
  assert.deepEqual(await conexao.getQueryInterface().describeTable('ciclos_leitura'), ciclosAnteriores);
  const [indicesAposRollback] = await conexao.query("SELECT to_regclass('ciclos_leitura_unico_em_andamento') AS indice");
  assert.equal(indicesAposRollback[0].indice, null);
  assert.deepEqual(await migracoesAplicadas(), migracoesConhecidas.slice(0, 5));
  executarCli('db:migrate:undo');
  assert.deepEqual(await conexao.getQueryInterface().describeTable('livros'), livrosAnteriores);
  assert.deepEqual(await migracoesAplicadas(), migracoesConhecidas.slice(0, 4));
  assert.equal((await conexao.getQueryInterface().describeTable('generos')).nome.type, 'CHARACTER VARYING(60)');
  executarCli('db:migrate:undo');
  assert.deepEqual(await conexao.getQueryInterface().describeTable('generos'), generosAnteriores);
  assert.deepEqual(await migracoesAplicadas(), migracoesConhecidas.slice(0, 3));
  executarCli('db:migrate:undo');
  assert.ok(!(await conexao.getQueryInterface().showAllTables()).includes('sessoes'));
  executarCli('db:migrate:undo');
  assert.deepEqual(await conexao.getQueryInterface().describeTable('usuarios'), estruturaAnterior);
  assert.deepEqual(await migracoesAplicadas(), [migracaoAnterior]);

  executarCli('db:migrate');
  await conferirSchemaAtual();
});
