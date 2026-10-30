'use strict';

const assert = require('node:assert/strict');
const caminho = require('node:path');
const { spawnSync } = require('node:child_process');
const { scryptSync } = require('node:crypto');
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
const migracaoEncontros = '20261030040000-completar-encontros.js';
const migracaoParticipacoes = '20261030050000-completar-participacoes-leitura.js';
const migracaoInscricoes = '20261030051000-ajustar-inscricoes-encontro.js';
const migracoesConhecidas = [
  migracaoAnterior, migracaoUsuarios, migracaoSessoes, migracaoGeneros,
  migracaoLivros, migracaoCiclos, migracaoEncontros, migracaoParticipacoes, migracaoInscricoes,
];
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

async function conferirFkInscricao(acao) {
  const [chaves] = await conexao.query(`
    SELECT conname, confdeltype FROM pg_catalog.pg_constraint
     WHERE conrelid = 'inscricoes_encontro'::regclass AND contype = 'f'
     ORDER BY conname
  `);
  assert.deepEqual(chaves, [
    { conname: 'inscricoes_encontro_encontro_id_fkey', confdeltype: acao },
    { conname: 'inscricoes_encontro_usuario_id_fkey', confdeltype: 'r' },
  ]);
}

async function conferirSchemaAtual(migracoesEsperadas = migracoesConhecidas) {
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
  const encontros = await conexao.getQueryInterface().describeTable('encontros');
  assert.equal(encontros.ciclo_id.allowNull, false);
  assert.equal(encontros.inicio_em.type, 'TIMESTAMP WITH TIME ZONE');
  assert.equal(encontros.inicio_em.allowNull, false);
  assert.equal(encontros.titulo.type, 'CHARACTER VARYING(120)');
  assert.equal(encontros.local.type, 'CHARACTER VARYING(180)');
  assert.equal(encontros.descricao.allowNull, true);
  assert.match(String(encontros.situacao.defaultValue), /AGENDADO/);
  assert.equal(encontros.ciclo_leitura_id, undefined);
  assert.equal(encontros.data_hora, undefined);
  const indicesEncontros = await conexao.getQueryInterface().showIndex('encontros');
  assert.deepEqual(indicesEncontros.map((indice) => indice.name).sort(), [
    'encontros_ciclo_inicio_indice', 'encontros_inicio_indice', 'encontros_pkey',
  ]);
  if (migracoesEsperadas.includes(migracaoParticipacoes)) {
    const participacoes = await conexao.getQueryInterface().describeTable('participacoes_leitura');
    assert.equal(participacoes.ciclo_id.allowNull, false);
    assert.equal(participacoes.ciclo_leitura_id, undefined);
    assert.equal(participacoes.pagina_atual.type, 'INTEGER');
    assert.equal(participacoes.pagina_atual.allowNull, false);
    assert.equal(Number(participacoes.pagina_atual.defaultValue), 0);
    assert.equal(participacoes.concluida_em.type, 'TIMESTAMP WITH TIME ZONE');
    assert.equal(participacoes.concluida_em.allowNull, true);
    const indices = await conexao.getQueryInterface().showIndex('participacoes_leitura');
    assert.deepEqual(indices.map((indice) => indice.name).sort(), [
      'participacoes_leitura_pkey', 'participacoes_leitura_usuario_ciclo_unico',
    ]);
    const unico = indices.find((indice) => indice.name === 'participacoes_leitura_usuario_ciclo_unico');
    assert.equal(unico.unique, true);
    assert.deepEqual(unico.fields.map((campo) => campo.attribute), ['usuario_id', 'ciclo_id']);
  }
  await conferirFkInscricao(migracoesEsperadas.includes(migracaoInscricoes) ? 'c' : 'r');
  assert.deepEqual(await migracoesAplicadas(), migracoesEsperadas);
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
  const encontrosAnteriores = await conexao.getQueryInterface().describeTable('encontros');
  const participacoesAnteriores = await conexao.getQueryInterface().describeTable('participacoes_leitura');
  const inscricoesAnteriores = await conexao.getQueryInterface().describeTable('inscricoes_encontro');

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

  executarCli('db:migrate', ['--to', migracaoCiclos]);
  validarDestinoTeste(conexao);
  const [generosEncontro] = await conexao.query(`
    INSERT INTO generos (nome, criado_em, atualizado_em)
    VALUES ('Gênero do encontro legado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `);
  const [livrosEncontro] = await conexao.query(`
    INSERT INTO livros (titulo, autor, genero_id, total_paginas, criado_em, atualizado_em)
    VALUES ('Obra do encontro', 'Autor', $1, 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [generosEncontro[0].id] });
  const [ciclosEncontro] = await conexao.query(`
    INSERT INTO ciclos_leitura (nome, livro_id, data_inicio, data_fim, criado_em, atualizado_em)
    VALUES ('Ciclo do encontro', $1, '2026-11-01', '2026-11-30', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [livrosEncontro[0].id] });
  const [encontrosLegados] = await conexao.query(`
    INSERT INTO encontros (ciclo_leitura_id, titulo, data_hora, local, criado_em, atualizado_em)
    VALUES ($1, 'Encontro preservado', '2026-11-10T10:30:00.123456-03:00', 'Biblioteca', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING id, EXTRACT(EPOCH FROM data_hora)::text AS instante
  `, { bind: [ciclosEncontro[0].id] });

  try {
    executarCli('db:migrate', ['--to', migracaoEncontros]);
    await conferirSchemaAtual(migracoesConhecidas.slice(0, 7));
    const [preservados] = await conexao.query(`
      SELECT id, ciclo_id, titulo, local, descricao, situacao,
             EXTRACT(EPOCH FROM inicio_em)::text AS instante
        FROM encontros WHERE id = $1
    `, { bind: [encontrosLegados[0].id] });
    assert.deepEqual(preservados[0], {
      id: encontrosLegados[0].id, ciclo_id: ciclosEncontro[0].id,
      titulo: 'Encontro preservado', local: 'Biblioteca', descricao: null,
      situacao: 'AGENDADO', instante: encontrosLegados[0].instante,
    });

    executarCli('db:migrate:undo');
    assert.deepEqual(await conexao.getQueryInterface().describeTable('encontros'), encontrosAnteriores);
    const [restaurados] = await conexao.query(`
      SELECT ciclo_leitura_id, titulo, local, EXTRACT(EPOCH FROM data_hora)::text AS instante
        FROM encontros WHERE id = $1
    `, { bind: [encontrosLegados[0].id] });
    assert.deepEqual(restaurados[0], {
      ciclo_leitura_id: ciclosEncontro[0].id, titulo: 'Encontro preservado',
      local: 'Biblioteca', instante: encontrosLegados[0].instante,
    });
    assert.deepEqual(await migracoesAplicadas(), migracoesConhecidas.slice(0, 6));

    executarCli('db:migrate', ['--to', migracaoEncontros]);
    const [reaplicados] = await conexao.query('SELECT EXTRACT(EPOCH FROM inicio_em)::text AS instante FROM encontros WHERE id = $1', {
      bind: [encontrosLegados[0].id],
    });
    assert.equal(reaplicados[0].instante, encontrosLegados[0].instante);
  } finally {
    validarDestinoTeste(conexao);
    await conexao.query('DELETE FROM encontros WHERE id = $1', { bind: [encontrosLegados[0].id] });
    await conexao.query('DELETE FROM ciclos_leitura WHERE id = $1', { bind: [ciclosEncontro[0].id] });
    await conexao.query('DELETE FROM livros WHERE id = $1', { bind: [livrosEncontro[0].id] });
    await conexao.query('DELETE FROM generos WHERE id = $1', { bind: [generosEncontro[0].id] });
  }

  // Exercita as junções com registros existentes, sem inventar credenciais ou
  // substituir as unicidades e FKs protegidas pelas migrations anteriores.
  validarDestinoTeste(conexao);
  const sal = 'leia-migrations-adesoes';
  const hash = `scrypt$${sal}$${scryptSync('entrada de teste', sal, 32).toString('hex')}`;
  const [usuariosAdesao] = await conexao.query(`
    INSERT INTO usuarios (nome, email, senha_hash, criado_em, atualizado_em)
    VALUES ('Leitor da adesão', 'adesao@escola.exemplo', $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [hash] });
  const [generosAdesao] = await conexao.query(`
    INSERT INTO generos (nome, criado_em, atualizado_em)
    VALUES ('Gênero da adesão', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `);
  const [livrosAdesao] = await conexao.query(`
    INSERT INTO livros (titulo, autor, genero_id, total_paginas, criado_em, atualizado_em)
    VALUES ('Obra da adesão', 'Autor', $1, 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [generosAdesao[0].id] });
  const [ciclosAdesao] = await conexao.query(`
    INSERT INTO ciclos_leitura (nome, livro_id, data_inicio, data_fim, criado_em, atualizado_em)
    VALUES ('Ciclo da adesão', $1, '2026-11-01', '2026-11-30', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [livrosAdesao[0].id] });
  const [encontrosAdesao] = await conexao.query(`
    INSERT INTO encontros (ciclo_id, titulo, inicio_em, local, criado_em, atualizado_em)
    VALUES ($1, 'Encontro da adesão', '2026-11-10T10:30:00-03:00', 'Biblioteca', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [ciclosAdesao[0].id] });
  const [participacoesLegadas] = await conexao.query(`
    INSERT INTO participacoes_leitura (usuario_id, ciclo_leitura_id, criado_em, atualizado_em)
    VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [usuariosAdesao[0].id, ciclosAdesao[0].id] });
  const [inscricoesLegadas] = await conexao.query(`
    INSERT INTO inscricoes_encontro (usuario_id, encontro_id, criado_em, atualizado_em)
    VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id
  `, { bind: [usuariosAdesao[0].id, encontrosAdesao[0].id] });

  try {
    executarCli('db:migrate');
    await conferirSchemaAtual();
    const [participacoes] = await conexao.query(`
      SELECT id, usuario_id, ciclo_id, pagina_atual, concluida_em FROM participacoes_leitura WHERE id = $1
    `, { bind: [participacoesLegadas[0].id] });
    assert.deepEqual(participacoes[0], {
      id: participacoesLegadas[0].id, usuario_id: usuariosAdesao[0].id,
      ciclo_id: ciclosAdesao[0].id, pagina_atual: 0, concluida_em: null,
    });
    const [inscricoes] = await conexao.query('SELECT id, usuario_id, encontro_id FROM inscricoes_encontro WHERE id = $1', {
      bind: [inscricoesLegadas[0].id],
    });
    assert.deepEqual(inscricoes[0], {
      id: inscricoesLegadas[0].id, usuario_id: usuariosAdesao[0].id, encontro_id: encontrosAdesao[0].id,
    });

    executarCli('db:migrate:undo');
    await conferirFkInscricao('r');
    assert.deepEqual(await conexao.getQueryInterface().describeTable('inscricoes_encontro'), inscricoesAnteriores);
    executarCli('db:migrate:undo');
    assert.deepEqual(await conexao.getQueryInterface().describeTable('participacoes_leitura'), participacoesAnteriores);
    const [restauradas] = await conexao.query('SELECT id, usuario_id, ciclo_leitura_id FROM participacoes_leitura WHERE id = $1', {
      bind: [participacoesLegadas[0].id],
    });
    assert.deepEqual(restauradas[0], {
      id: participacoesLegadas[0].id, usuario_id: usuariosAdesao[0].id, ciclo_leitura_id: ciclosAdesao[0].id,
    });
    assert.deepEqual(await migracoesAplicadas(), migracoesConhecidas.slice(0, 7));

    executarCli('db:migrate');
    await conferirSchemaAtual();
  } finally {
    validarDestinoTeste(conexao);
    await conexao.query('DELETE FROM inscricoes_encontro WHERE id = $1', { bind: [inscricoesLegadas[0].id] });
    await conexao.query('DELETE FROM participacoes_leitura WHERE id = $1', { bind: [participacoesLegadas[0].id] });
    await conexao.query('DELETE FROM encontros WHERE id = $1', { bind: [encontrosAdesao[0].id] });
    await conexao.query('DELETE FROM ciclos_leitura WHERE id = $1', { bind: [ciclosAdesao[0].id] });
    await conexao.query('DELETE FROM livros WHERE id = $1', { bind: [livrosAdesao[0].id] });
    await conexao.query('DELETE FROM generos WHERE id = $1', { bind: [generosAdesao[0].id] });
    await conexao.query('DELETE FROM usuarios WHERE id = $1', { bind: [usuariosAdesao[0].id] });
  }

  // A ordem inversa começa pelas junções, conservando os schemas anteriores.
  executarCli('db:migrate:undo');
  await conferirFkInscricao('r');
  assert.deepEqual(await conexao.getQueryInterface().describeTable('inscricoes_encontro'), inscricoesAnteriores);
  executarCli('db:migrate:undo');
  assert.deepEqual(await conexao.getQueryInterface().describeTable('participacoes_leitura'), participacoesAnteriores);
  assert.deepEqual(await migracoesAplicadas(), migracoesConhecidas.slice(0, 7));
  executarCli('db:migrate:undo');
  assert.deepEqual(await conexao.getQueryInterface().describeTable('encontros'), encontrosAnteriores);
  assert.deepEqual((await conexao.getQueryInterface().showIndex('encontros')).map((indice) => indice.name), ['encontros_pkey']);
  assert.deepEqual(await migracoesAplicadas(), migracoesConhecidas.slice(0, 6));
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
