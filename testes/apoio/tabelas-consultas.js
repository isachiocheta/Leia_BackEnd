'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

const tabelas = ['usuarios', 'generos', 'livros', 'ciclos_leitura', 'encontros', 'participacoes_leitura', 'inscricoes_encontro'];

async function criarTabelasTemporarias(conexao, transaction) {
  validarDestinoTeste(conexao);
  for (const tabela of tabelas) {
    // Identificadores são desta lista interna. LIKE copia tipos, checks e índices
    // das migrations; não altera tabelas públicas nem usa sync do Sequelize.
    await conexao.query(`CREATE TEMP TABLE "${tabela}" (LIKE public."${tabela}" INCLUDING ALL) ON COMMIT DROP`, { transaction });
  }
  const [linhas] = await conexao.query("SELECT 'usuarios'::regclass::oid = 'pg_temp.usuarios'::regclass::oid AS isolado", { transaction });
  if (!linhas[0].isolado) throw new Error('As consultas de teste não estão isoladas.');
}

async function popularAvaliacao(conexao, transaction, senhaHash) {
  await criarTabelasTemporarias(conexao, transaction);
  const opcoes = { transaction };
  await conexao.query(`INSERT INTO generos (id, nome, criado_em, atualizado_em)
    SELECT g, 'Gênero ' || g, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM generate_series(1, 5) g`, opcoes);
  await conexao.query(`INSERT INTO usuarios (id, nome, email, senha_hash, perfil, situacao, session_version, criado_em, atualizado_em)
    SELECT g, 'Leitor ' || g, 'leitor' || g || '@fixture.example', $hash, 'LEITOR', 'ATIVO', 0,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM generate_series(1, 12000) g`, { transaction, bind: { hash: senhaHash } });
  await conexao.query(`INSERT INTO livros (id, titulo, autor, genero_id, total_paginas, criado_em, atualizado_em)
    SELECT g, 'Obra ' || g, 'Autora', ((g-1)%5)+1, 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM generate_series(1, 1200) g`, opcoes);
  await conexao.query(`INSERT INTO ciclos_leitura (id, nome, livro_id, data_inicio, data_fim, situacao, criado_em, atualizado_em)
    SELECT g, 'Ciclo ' || g, ((g-1)%1200)+1, DATE '2026-11-01', DATE '2026-11-30', 'PLANEJADO',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM generate_series(1, 6000) g`, opcoes);
  await conexao.query(`INSERT INTO participacoes_leitura (id, usuario_id, ciclo_id, pagina_atual, concluida_em, criado_em, atualizado_em)
    SELECT g, ((g-1)/6000)*2000+((g-1)%2000)+1, ((g-1)%6000)+1, g%101,
      CASE WHEN g%101=100 THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM generate_series(1, 30000) g`, opcoes);
  await conexao.query(`INSERT INTO encontros (id, ciclo_id, titulo, inicio_em, local, situacao, criado_em, atualizado_em)
    SELECT g, ((g-1)%6000)+1, 'Encontro ' || g, TIMESTAMPTZ '2026-11-01T12:00:00Z' + (g%60)*INTERVAL '1 hour',
      'Biblioteca', 'AGENDADO', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM generate_series(1, 24000) g`, opcoes);
  await conexao.query(`INSERT INTO inscricoes_encontro (id, usuario_id, encontro_id, criado_em, atualizado_em)
    SELECT g, ((g-1)/24000)*6000+((g-1)%6000)+1, ((g-1)%24000)+1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM generate_series(1, 48000) g`, opcoes);
  for (const tabela of tabelas) await conexao.query(`ANALYZE pg_temp."${tabela}"`, opcoes);
}

module.exports = { criarTabelasTemporarias, popularAvaliacao };
