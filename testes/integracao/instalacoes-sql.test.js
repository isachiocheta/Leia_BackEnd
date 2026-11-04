'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { readFile, readdir } = require('node:fs/promises');
const caminho = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');
const express = require('express');
const supertest = require('supertest');
const bcrypt = require('bcrypt');
const { criarBancoTemporario } = require('../../database/banco-temporario');
const { instalarReferencia, gerarArtefatos } = require('../../database/exportar-sql');
const { carregarConfiguracaoSessao } = require('../../configuracao/sessao');
const { criarAutenticacao } = require('../../autenticacao/rotas');
const { configurarHttp } = require('../../intermediarios/http');
const { tratarErros } = require('../../intermediarios/erros');

const backend = caminho.resolve(__dirname, '../..');
const nomes = ['001_schema.sql', '002_reference_data.sql', '003_migration_metadata.sql'];

async function catalogo(conexao) {
  const consultas = {
    colunas: `SELECT t.relname AS tabela, a.attname AS coluna, format_type(a.atttypid,a.atttypmod) AS tipo, a.attnotnull AS obrigatoria,
      pg_get_expr(d.adbin,d.adrelid) AS padrao FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_attribute a ON a.attrelid=t.oid LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND t.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY t.relname,a.attnum`,
    constraints: `SELECT t.relname AS tabela,c.conname AS nome,c.contype AS tipo,pg_get_constraintdef(c.oid) AS definicao
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' ORDER BY t.relname,c.conname`,
    indices: `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
    sequencias: `SELECT sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`,
  };
  const resultado = {};
  for (const [nome, sql] of Object.entries(consultas)) [resultado[nome]] = await conexao.query(sql);
  // O deparser pode distribuir o cast text[] nos elementos após restaurar um
  // dump: ARRAY[varchar]::text[] e ARRAY[varchar::text] são equivalentes aqui.
  // Preserva nomes, constantes, operadores e todas as demais expressões.
  resultado.constraints = resultado.constraints.map((linha) => ({ ...linha, definicao: linha.definicao
    .replace(/\((ARRAY\[[^\]]+\])\)::text\[\]/g, '$1')
    .replace(/\('([^']*)'::character varying\)::text/g, "'$1'::character varying") }));
  return resultado;
}

function tabelasLogicas(texto) {
  const tabelas = {};
  for (const ocorrencia of texto.matchAll(/^Table (\w+) \{/gm)) {
    let profundidade = 1; let fim = ocorrencia.index + ocorrencia[0].length;
    const inicio = fim;
    for (; profundidade > 0 && fim < texto.length; fim += 1) { if (texto[fim] === '{') profundidade += 1; if (texto[fim] === '}') profundidade -= 1; }
    tabelas[ocorrencia[1]] = [...texto.slice(inicio, fim - 1).matchAll(/^  (\w+) (\w+(?:\(\d+\))?)(?: (\[[^\n]+\]))?$/gm)]
      .filter((linha) => !['checks', 'indexes'].includes(linha[1])).map((linha) => ({ coluna: linha[1], tipo: linha[2], obrigatoria: /not null|\bpk\b/.test(linha[3] || '') }));
  }
  return tabelas;
}

describe('Instalações equivalentes por migrations e SQL em bancos distintos e vazios', { timeout: 120_000 }, () => {
  let migracoes; let sql; let arquivos;
  before(async () => {
    migracoes = await criarBancoTemporario('migracoes'); sql = await criarBancoTemporario('sql');
    assert.notEqual(migracoes.nome, sql.nome); await instalarReferencia(migracoes.variaveis);
    arquivos = Object.fromEntries(await Promise.all(nomes.map(async (nome) => [nome, await readFile(caminho.join(backend, 'database/sql', nome), 'utf8')])));
    const cliente = new Client({ connectionString: sql.variaveis.TEST_DATABASE_URL }); await cliente.connect();
    try { for (const nome of nomes) await cliente.query(arquivos[nome]); } finally { await cliente.end(); }
  });
  after(async () => { try { if (migracoes) await migracoes.encerrar(); } finally { if (sql) await sql.encerrar(); } });

  it('DDL físico, tipos, defaults, constraints, FKs, índices e sequências coincidem integralmente', async () => {
    assert.deepEqual(await catalogo(sql.conexao), await catalogo(migracoes.conexao));
    assert.doesNotMatch(arquivos[nomes[0]], /^INSERT INTO |^COPY |^SELECT pg_catalog.setval/gm);
    for (const nome of nomes.slice(1)) assert.doesNotMatch(arquivos[nome], /^(CREATE|ALTER|DROP) /gm);
    const tabelas = [...arquivos[nomes[0]].matchAll(/^CREATE TABLE public\.(\w+) /gm)].map((linha) => linha[1]);
    assert.equal(tabelas.length, new Set(tabelas).size); assert.equal(tabelas.length, 12);
    const [vazias] = await sql.conexao.query('SELECT (SELECT COUNT(*) FROM usuarios)::int AS usuarios,(SELECT COUNT(*) FROM sessoes)::int AS sessoes,(SELECT COUNT(*) FROM cargas_demonstracao)::int AS demo');
    assert.deepEqual(vazias, [{ usuarios: 0, sessoes: 0, demo: 0 }]);
  });

  it('referência, proveniência e histórico correspondem; CLI não reaplica migrations nem seed básico após importação', async () => {
    const [a] = await migracoes.conexao.query('SELECT id,nome FROM generos ORDER BY id'); const [b] = await sql.conexao.query('SELECT id,nome FROM generos ORDER BY id'); assert.deepEqual(b, a);
    for (const tabela of ['sequelize_meta', 'sequelize_seeds', 'generos_semeados']) {
      const [origem] = await migracoes.conexao.query(`SELECT * FROM ${tabela} ORDER BY 1${tabela === 'generos_semeados' ? ',2' : ''}`);
      const [importada] = await sql.conexao.query(`SELECT * FROM ${tabela} ORDER BY 1${tabela === 'generos_semeados' ? ',2' : ''}`); assert.deepEqual(importada, origem);
    }
    const [antes] = await sql.conexao.query('SELECT * FROM generos ORDER BY id');
    await instalarReferencia(sql.variaveis); const [depois] = await sql.conexao.query('SELECT * FROM generos ORDER BY id'); assert.deepEqual(depois, antes);
    const migracoesEsperadas = (await readdir(caminho.join(backend, 'database/migracoes'))).filter((nome) => nome.endsWith('.js')).sort();
    const [registros] = await sql.conexao.query('SELECT name FROM sequelize_meta ORDER BY name'); assert.deepEqual(registros.map((linha) => linha.name), migracoesEsperadas);
    assert.deepEqual([...arquivos[nomes[2]].matchAll(/^INSERT INTO public\.(\w+) /gm)].map((linha) => linha[1]).filter((tabela) => !['sequelize_meta', 'sequelize_seeds', 'generos_semeados'].includes(tabela)), []);
  });

  it('ER e lógico correspondem às tabelas/colunas/FKs físicas, sem misturar controles técnicos ao domínio', async () => {
    const logico = await readFile(caminho.join(backend, 'database/modelagem/logico.dbml'), 'utf8');
    const er = await readFile(caminho.join(backend, 'database/modelagem/conceitual.puml'), 'utf8');
    const tabelas = tabelasLogicas(logico); const fisico = await catalogo(sql.conexao);
    assert.deepEqual(Object.keys(tabelas).sort(), [...new Set(fisico.colunas.map((linha) => linha.tabela))].sort());
    const tipo = (valor) => valor.replace(/^varchar/, 'character varying').replace(/^timestamptz$/, 'timestamp with time zone').replace(/^timestamp\(6\)$/, 'timestamp(6) without time zone');
    for (const [tabela, colunas] of Object.entries(tabelas)) {
      const reais = fisico.colunas.filter((linha) => linha.tabela === tabela);
      assert.deepEqual(colunas.map((coluna) => coluna.coluna).sort(), reais.map((coluna) => coluna.coluna).sort(), tabela);
      for (const coluna of colunas) {
        const real = reais.find((linha) => linha.coluna === coluna.coluna); assert.equal(real.tipo, tipo(coluna.tipo), `${tabela}.${coluna.coluna}`); assert.equal(real.obrigatoria, coluna.obrigatoria);
      }
    }
    const referencias = [...logico.matchAll(/^Ref: (\w+)\.(\w+) > (\w+)\.(\w+) \[delete: (\w+), update: (\w+)\]/gm)];
    const fks = fisico.constraints.filter((linha) => linha.tipo === 'f'); assert.equal(fks.length, referencias.length);
    for (const [, tabela, coluna, destino, chave, exclusao, atualizacao] of referencias) {
      assert.ok(fks.some((fk) => fk.tabela === tabela && fk.definicao === `FOREIGN KEY (${coluna}) REFERENCES ${destino}(${chave}) ON UPDATE ${atualizacao.toUpperCase()} ON DELETE ${exclusao.toUpperCase()}`), `${tabela}.${coluna}`);
    }
    for (const [, nome] of logico.matchAll(/\[name: '([^']+)'\]/g)) assert.ok(fisico.constraints.some((linha) => linha.nome === nome) || fisico.indices.some((linha) => linha.indexname === nome), nome);
    for (const [pai, filho] of [['genero', 'livro'], ['livro', 'ciclo'], ['ciclo', 'encontro'], ['usuario', 'participacao'], ['ciclo', 'participacao'], ['usuario', 'inscricao'], ['encontro', 'inscricao']]) assert.ok(er.includes(`${pai} ||--o{ ${filho}`));
    assert.match(er, /cargas_demonstracao.*técnica/); assert.match(logico, /TableGroup infraestrutura \{\s+cargas_demonstracao/);
    const parcial = fisico.indices.find((linha) => linha.indexname === 'ciclos_leitura_unico_em_andamento'); assert.match(parcial.indexdef, /\(\(1\)\).*WHERE.*EM_ANDAMENTO/);
  });

  it('gerador usa outro banco vazio, ignora credenciais de bootstrap/demo e não exporta suas linhas', async () => {
    const senhasDemo = Object.fromEntries(['INICIO', 'METADE', 'FINAL', 'SEM_PARTICIPACAO', 'PENDENTE'].map((nome) => [`DEMO_SENHA_${nome}`, 'Senha que não deve ser exportada']));
    const arquivosNovos = await gerarArtefatos({ ...process.env, ...senhasDemo, DEMO_DATA_BASE: '2026-11-03', ADMIN_NOME: 'Nunca exportar', ADMIN_EMAIL: 'nunca@export.example', ADMIN_SENHA: 'Senha que não deve ser exportada' });
    assert.equal(arquivosNovos[nomes[0]], arquivos[nomes[0]]);
    assert.equal(arquivosNovos[nomes[2]], arquivos[nomes[2]]);
    for (const conteudo of Object.values(arquivosNovos)) {
      assert.doesNotMatch(conteudo, /Nunca exportar|nunca@export|Senha que não deve|\$2[aby]\$|^INSERT INTO public\.(usuarios|sessoes|cargas_demonstracao)/gm);
    }
  });

  it('sequências importadas continuam corretamente e a tabela de sessões funciona com autenticação real', async () => {
    const genero = await sql.conexao.models.Genero.create({ nome: 'Gênero após SQL' }); assert.equal(genero.id, 7);
    const senha = 'Senha da instalação SQL 22';
    const usuario = await sql.conexao.models.Usuario.create({ nome: 'Leitor SQL', email: 'leitor@sql.example', senhaHash: await bcrypt.hash(senha, 4), perfil: 'LEITOR', situacao: 'ATIVO', sessionVersion: 0 }); assert.equal(usuario.id, 1);
    const pool = new Pool({ connectionString: sql.variaveis.TEST_DATABASE_URL });
    const autenticacao = criarAutenticacao({ configuracao: carregarConfiguracaoSessao({ NODE_ENV: 'test', SESSION_SECRET: 'Segredo exclusivo da instalação SQL Leia+ 22', SESSION_COOKIE_SECURE: 'false' }), pool, obterUsuario: () => sql.conexao.models.Usuario });
    const app = express(); configurarHttp(app, { origemPermitida: 'http://localhost:5173' }); app.use('/api/auth', autenticacao.roteador); app.use(tratarErros);
    try {
      const agente = supertest.agent(app); const token = await agente.get('/api/auth/csrf'); assert.equal(token.status, 200);
      const login = await agente.post('/api/auth/login').set('X-CSRF-Token', token.body.data.csrfToken).send({ email: usuario.email, senha }); assert.equal(login.status, 200);
      assert.equal((await agente.get('/api/auth/me')).body.data.id, usuario.id);
      const [sessoes] = await sql.conexao.query('SELECT sess FROM sessoes'); assert.equal(sessoes.length, 1); assert.equal(sessoes[0].sess.passport.user.id, usuario.id);
    } finally { await autenticacao.encerrar(); await pool.end(); }
  });
});
