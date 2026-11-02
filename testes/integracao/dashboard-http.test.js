'use strict';

const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const bcrypt = require('bcrypt');
const express = require('express');
const supertest = require('supertest');
const { Pool } = require('pg');
const { ConnectionError } = require('sequelize');
const { criarConexao } = require('../../database/conexao');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { carregarConfiguracaoSessao } = require('../../configuracao/sessao');
const { criarAutenticacao } = require('../../autenticacao/rotas');
const { criarRotasDashboard } = require('../../dashboard/rotas');
const { criarRotasCiclos } = require('../../ciclos/rotas');
const { criarRotasEncontros } = require('../../encontros/rotas');
const { criarRotasPerfil } = require('../../perfil/rotas');
const { configurarHttp } = require('../../intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('../../intermediarios/erros');
const { carregarConsulta } = require('../../database/consultas/carregar');

const destino = validarBancoTeste(process.env);
const esquema = `leia_dashboard_${process.pid}_${Date.now()}`;
const tabelas = ['usuarios', 'generos', 'livros', 'ciclos_leitura', 'encontros', 'participacoes_leitura', 'inscricoes_encontro', 'sessoes'];
const senha = 'Senha das fixtures do dashboard';
const configuracao = carregarConfiguracaoSessao({ NODE_ENV: 'test', SESSION_SECRET: 'Segredo exclusivo dos testes reais do dashboard Leia+', SESSION_COOKIE_SECURE: 'false' });

describe('Dashboards HTTP e snapshot no PostgreSQL isolado', { timeout: 60_000 }, () => {
  let administracao; let conexao; let pool; let autenticacao; let app; let hash; let gestor; let leitor;
  let instante; let chamadasRelogio; let sequencias; let relogioAutenticacao;
  function validarEsquema() {
    validarDestinoTeste(administracao);
    assert.match(esquema, /^leia_dashboard_\d+_\d+$/);
  }
  before(async () => {
    administracao = criarConexao(); validarEsquema(); await administracao.authenticate();
    // Um schema exclusivo permite commits concorrentes reais, com contagens
    // determinísticas, sem disputar ciclos ativos ou dados das outras suítes.
    await administracao.query(`CREATE SCHEMA "${esquema}"`);
    for (const tabela of tabelas) await administracao.query(`CREATE TABLE "${esquema}"."${tabela}" (LIKE public."${tabela}" INCLUDING ALL)`);
    // LIKE não copia FKs. A agenda também é verificada após exclusão real por
    // CASCADE, com a mesma ação da migration, somente neste schema exclusivo.
    await administracao.query(`ALTER TABLE "${esquema}".inscricoes_encontro ADD CONSTRAINT inscricoes_dashboard_encontro_fk
      FOREIGN KEY (encontro_id) REFERENCES "${esquema}".encontros(id) ON DELETE CASCADE ON UPDATE CASCADE`);
    conexao = criarConexao();
    conexao.addHook('afterConnect', (cliente) => cliente.query(`SET search_path TO "${esquema}", public`));
    await conexao.authenticate(); validarDestinoTeste(conexao);
    const [linhas] = await conexao.query('SELECT current_schema() AS esquema'); assert.equal(linhas[0].esquema, esquema);
    // As demais FKs continuam exercitadas pelas integrações do schema público.
    pool = new Pool({ connectionString: destino.url, max: 3, options: `-c search_path=${esquema},public` });
    hash = await bcrypt.hash(senha, 4);
  });
  after(async () => {
    try {
      if (conexao) await conexao.close();
      if (pool) await pool.end();
      if (administracao) { validarEsquema(); await administracao.query(`DROP SCHEMA IF EXISTS "${esquema}" CASCADE`); }
    } finally { if (administracao) await administracao.close(); }
  });
  beforeEach(async () => {
    validarEsquema();
    await administracao.query(`TRUNCATE TABLE ${tabelas.map((tabela) => `"${esquema}"."${tabela}"`).join(', ')}`);
    instante = Date.parse('2026-11-02T15:00:00Z'); chamadasRelogio = 0; sequencias = {};
    relogioAutenticacao = Date.now();
    gestor = await usuario('ADMIN_CLUBE'); leitor = await usuario();
    autenticacao = criarAutenticacao({ configuracao, pool, obterUsuario: () => conexao.models.Usuario, agora: () => relogioAutenticacao });
    app = express(); configurarHttp(app, { origemPermitida: 'http://localhost:5173' });
    app.use('/api/auth', autenticacao.roteador);
    app.use('/api/dashboard', autenticacao.identificar, criarRotasDashboard({ obterConexao: () => conexao, agora: () => { chamadasRelogio += 1; return instante; } }));
    app.use('/api/ciclos', autenticacao.identificar, criarRotasCiclos({ obterConexao: () => conexao, agora: () => instante }));
    app.use('/api/encontros', autenticacao.identificar, criarRotasEncontros({ obterConexao: () => conexao, agora: () => instante }));
    app.use('/api/me', autenticacao.identificar, criarRotasPerfil({ obterUsuario: () => conexao.models.Usuario, obterConexao: () => conexao, agora: () => instante }));
    app.use(rotaNaoEncontrada); app.use(tratarErros);
  });
  afterEach(async () => { if (autenticacao) await autenticacao.encerrar(); });

  function criar(modelo, dados, transaction) {
    sequencias[modelo] = (sequencias[modelo] || 0) + 1;
    return conexao.models[modelo].create({ ...dados, id: sequencias[modelo] }, { transaction });
  }
  function usuario(perfil = 'LEITOR', situacao = 'ATIVO', transaction) {
    return criar('Usuario', { nome: 'Pessoa do dashboard', email: `pessoa${(sequencias.Usuario || 0) + 1}@dashboard.example`, senhaHash: hash, perfil, situacao, sessionVersion: 0 }, transaction);
  }
  async function livro(totalPaginas = 300, transaction) {
    const genero = await criar('Genero', { nome: `Gênero ${(sequencias.Genero || 0) + 1}` }, transaction);
    return criar('Livro', { titulo: 'Obra do dashboard', autor: 'Autora', totalPaginas, generoId: genero.id }, transaction);
  }
  function ciclo(obra, situacao = 'EM_ANDAMENTO', extras = {}, transaction) {
    return criar('CicloLeitura', { nome: 'Ciclo do dashboard', livroId: obra.id, dataInicio: '2026-11-02', dataFim: '2026-11-03', situacao, ...extras }, transaction);
  }
  function participacao(pessoa, leitura, paginaAtual, transaction) {
    return criar('ParticipacaoLeitura', { usuarioId: pessoa.id, cicloId: leitura.id, paginaAtual,
      concluidaEm: paginaAtual === 300 ? new Date('2026-11-02T12:00:00Z') : null }, transaction);
  }
  function encontro(leitura, inicioEm, situacao = 'AGENDADO') {
    return criar('Encontro', { cicloId: leitura.id, titulo: 'Encontro do dashboard', inicioEm, situacao, local: 'Biblioteca' });
  }
  async function entrar(conta = gestor, aplicacao = app) {
    const agente = supertest.agent(aplicacao);
    const csrf = await agente.get('/api/auth/csrf'); assert.equal(csrf.status, 200);
    const resposta = await agente.post('/api/auth/login').set('X-CSRF-Token', csrf.body.data.csrfToken).send({ email: conta.email, senha });
    assert.equal(resposta.status, 200); return agente;
  }
  async function consultar(agente) {
    const resposta = await agente.get('/api/dashboard/admin');
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body)); assert.equal(resposta.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(resposta.body), ['data']);
    assert.doesNotMatch(JSON.stringify(resposta.body), /senha|sessionVersion|session_version|email|stack|"sql"/);
    return resposta.body.data;
  }
  async function consultarMeu(agente) {
    const resposta = await agente.get('/api/dashboard/me');
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body)); assert.equal(resposta.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(resposta.body), ['data']);
    assert.doesNotMatch(JSON.stringify(resposta.body), /senha|sessionVersion|session_version|email|stack|"sql"/);
    return resposta.body.data;
  }
  async function csrf(agente) {
    const resposta = await agente.get('/api/auth/csrf'); assert.equal(resposta.status, 200); return resposta.body.data.csrfToken;
  }
  function inscricao(pessoa, evento, transaction) {
    return criar('InscricaoEncontro', { usuarioId: pessoa.id, encontroId: evento.id }, transaction);
  }

  it('exige administrador ativo: anônimo 401, leitor 403 e cookie de administrador desativado 401', async () => {
    assert.equal((await supertest(app).get('/api/dashboard/admin')).status, 401);
    assert.equal((await (await entrar(leitor)).get('/api/dashboard/admin')).status, 403);
    const administrador = await entrar(); await consultar(administrador);
    await gestor.update({ situacao: 'INATIVO', sessionVersion: 1 });
    assert.equal((await administrador.get('/api/dashboard/admin')).status, 401);
    assert.equal(chamadasRelogio, 1);
  });

  it('três páginas 0/150/300 resultam em média 50 e conclusão 33,33%, sem multiplicar por encontros', async () => {
    const obra = await livro(); const leitura = await ciclo(obra); await ciclo(obra, 'PLANEJADO');
    const segundo = await usuario(); const desativado = await usuario('LEITOR', 'INATIVO');
    await usuario('LEITOR', 'PENDENTE'); const semAdesao = await usuario();
    for (const [pessoa, pagina] of [[leitor, 0], [segundo, 150], [desativado, 300]]) await participacao(pessoa, leitura, pagina);
    const eventos = [];
    for (const [inicio, situacao] of [['2026-11-02T15:00:00.001Z', 'AGENDADO'], ['2026-11-02T15:00:00Z', 'AGENDADO'],
      ['2026-11-02T14:59:59Z', 'AGENDADO'], ['2026-11-03T12:00:00Z', 'CANCELADO'],
      ['2026-11-03T13:00:00Z', 'REALIZADO'], ['2026-11-03T14:00:00Z', 'AGENDADO']]) eventos.push(await encontro(leitura, inicio, situacao));
    for (const pessoa of [leitor, segundo, desativado]) {
      for (const evento of eventos.slice(0, 2)) await criar('InscricaoEncontro', { usuarioId: pessoa.id, encontroId: evento.id });
    }
    const dados = await consultar(await entrar());
    assert.equal(dados.generatedAt, '2026-11-02T15:00:00.000Z'); assert.equal(chamadasRelogio, 1);
    assert.deepEqual(dados.leitores, { ativos: 3, pendentes: 1 });
    assert.equal(dados.totalLivros, 1); assert.equal(dados.totalCiclos, 2); assert.equal(dados.encontrosAgendadosFuturos, 2);
    assert.deepEqual(dados.cicloAtual.indicadores, { participantes: 3, leiturasConcluidas: 1, taxaConclusao: 33.33, progressoMedio: 50 });
    assert.equal(dados.cicloAtual.id, leitura.id); assert.equal(dados.cicloAtual.livro.id, obra.id);
    assert.equal(dados.cicloAtual.livro.totalPaginas, 300); assert.equal(dados.cicloAtual.dentroDoPeriodo, true);
    assert.equal(dados.cicloAtual.dataInicio, '2026-11-02'); assert.equal(dados.cicloAtual.dataFim, '2026-11-03');
    assert.equal(dados.livrosMaisUtilizados.data[0].totalCiclos, 2);
    assert.deepEqual(dados.leitoresSemParticipacao.data, [{ id: semAdesao.id, nome: semAdesao.nome }]);
    for (const valor of [...Object.values(dados.leitores), dados.totalLivros, dados.totalCiclos, dados.encontrosAgendadosFuturos,
      ...Object.values(dados.cicloAtual.indicadores), dados.livrosMaisUtilizados.meta.total, dados.leitoresSemParticipacao.meta.total]) assert.equal(typeof valor, 'number');
  });

  it('base sem obras/ciclos retorna zeros, cicloAtual null e listas vazias', async () => {
    const dados = await consultar(await entrar());
    assert.equal(dados.totalLivros, 0); assert.equal(dados.totalCiclos, 0); assert.equal(dados.encontrosAgendadosFuturos, 0);
    assert.equal(dados.cicloAtual, null); assert.deepEqual(dados.livrosMaisUtilizados.data, []);
    assert.equal(dados.livrosMaisUtilizados.meta.total, 0); assert.deepEqual(dados.leitoresSemParticipacao.data, []);
    assert.equal(dados.leitoresSemParticipacao.meta.total, 0);
  });

  it('não substitui ciclo atual por planejado ou concluído e não altera situações pelas datas', async () => {
    const obra = await livro(); const planejado = await ciclo(obra, 'PLANEJADO'); const encerrado = await ciclo(obra, 'CONCLUIDO');
    await participacao(leitor, encerrado, 300);
    const dados = await consultar(await entrar()); assert.equal(dados.cicloAtual, null);
    assert.equal(dados.leitoresSemParticipacao.meta.total, 0); assert.deepEqual(dados.leitoresSemParticipacao.data, []);
    await planejado.reload(); await encerrado.reload(); assert.equal(planejado.situacao, 'PLANEJADO'); assert.equal(encerrado.situacao, 'CONCLUIDO');
  });

  it('ciclo vazio tem percentuais zero e conclusão não depende de percentual arredondado', async () => {
    const obra = await livro(20000); const leitura = await ciclo(obra); const administrador = await entrar();
    const vazio = await consultar(administrador);
    assert.deepEqual(vazio.cicloAtual.indicadores, { participantes: 0, leiturasConcluidas: 0, taxaConclusao: 0, progressoMedio: 0 });
    assert.equal(vazio.leitoresSemParticipacao.meta.total, 1);
    await participacao(leitor, leitura, 19999);
    const dados = await consultar(administrador);
    assert.deepEqual(dados.cicloAtual.indicadores, { participantes: 1, leiturasConcluidas: 0, taxaConclusao: 0, progressoMedio: 100 });
  });

  it('período usa São Paulo e inclui todo o último dia; ciclo vencido continua atual', async () => {
    const obra = await livro(); const leitura = await ciclo(obra, 'EM_ANDAMENTO', { dataFim: '2026-11-02' }); const administrador = await entrar();
    for (const [agora, esperado] of [['2026-11-02T02:59:59.999Z', false], ['2026-11-02T03:00:00Z', true],
      ['2026-11-03T02:59:59.999Z', true], ['2026-11-03T03:00:00Z', false]]) {
      instante = Date.parse(agora); const dados = await consultar(administrador);
      assert.equal(dados.generatedAt, new Date(instante).toISOString()); assert.equal(dados.cicloAtual.dentroDoPeriodo, esperado);
      assert.equal(dados.cicloAtual.id, leitura.id); assert.equal(dados.cicloAtual.situacao, 'EM_ANDAMENTO');
    }
    await leitura.reload(); assert.equal(leitura.situacao, 'EM_ANDAMENTO'); assert.equal(chamadasRelogio, 4);
  });

  it('listas têm totais completos, limites, desempate por id e só leitores ativos sem adesão', async () => {
    let leitura;
    for (let i = 1; i <= 8; i += 1) {
      const obra = await livro(); if (i === 8) continue;
      const atual = await ciclo(obra, i === 1 ? 'EM_ANDAMENTO' : 'PLANEJADO'); if (i === 1) leitura = atual;
      if (i === 7) for (let repeticao = 0; repeticao < 5; repeticao += 1) await ciclo(obra, 'CONCLUIDO');
    }
    await participacao(leitor, leitura, 0);
    const ausentes = []; for (let i = 0; i < 14; i += 1) ausentes.push(await usuario());
    await usuario('LEITOR', 'INATIVO'); await usuario('LEITOR', 'PENDENTE'); await usuario('ADMIN_CLUBE');
    const dados = await consultar(await entrar());
    assert.deepEqual(dados.livrosMaisUtilizados.meta, { page: 1, pageSize: 5, total: 7 });
    assert.deepEqual(dados.livrosMaisUtilizados.data.map((obra) => obra.id), [7, 1, 2, 3, 4]);
    assert.equal(dados.livrosMaisUtilizados.data[0].totalCiclos, 6);
    assert.deepEqual(dados.leitoresSemParticipacao.meta, { page: 1, pageSize: 12, total: 14 });
    assert.deepEqual(dados.leitoresSemParticipacao.data.map((pessoa) => pessoa.id), ausentes.slice(0, 12).map((pessoa) => pessoa.id));
  });

  it('commit concorrente não mistura snapshots; nova requisição vê os dados sem cache', async (contexto) => {
    const obra = await livro(); const leitura = await ciclo(obra); await participacao(leitor, leitura, 0);
    const administrador = await entrar(); let sinalizar; let liberar; let interceptar = true;
    const pronta = new Promise((resolver) => { sinalizar = resolver; }); const liberada = new Promise((resolver) => { liberar = resolver; });
    const original = conexao.query;
    contexto.mock.method(conexao, 'query', async function (sql, opcoes) {
      const resultado = await original.call(this, sql, opcoes);
      if (interceptar && sql === carregarConsulta('totaisDashboard')) {
        interceptar = false;
        const [estado] = await original.call(this, "SELECT current_setting('transaction_isolation') AS isolamento, current_setting('transaction_read_only') AS leitura", { transaction: opcoes.transaction });
        assert.equal(estado[0].isolamento, 'repeatable read'); assert.equal(estado[0].leitura, 'on');
        sinalizar(); await liberada;
      }
      return resultado;
    });
    const pedido = administrador.get('/api/dashboard/admin').then((resposta) => resposta);
    let prazo; let novaLeitura; let novoLeitor;
    try {
      await Promise.race([pronta, new Promise((_, rejeitar) => { prazo = setTimeout(() => rejeitar(new Error('Snapshot não foi alcançado.')), 5000); })]);
      await conexao.transaction(async (transaction) => {
        await leitor.update({ situacao: 'INATIVO', sessionVersion: 1 }, { transaction });
        novoLeitor = await usuario('LEITOR', 'ATIVO', transaction); await participacao(novoLeitor, leitura, 300, transaction);
        await leitura.update({ situacao: 'CONCLUIDO' }, { transaction });
        novaLeitura = await ciclo(await livro(300, transaction), 'EM_ANDAMENTO', {}, transaction);
      });
    } finally { clearTimeout(prazo); liberar(); }
    const resposta = await pedido; assert.equal(resposta.status, 200); const dados = resposta.body.data;
    assert.equal(dados.totalLivros, 1); assert.equal(dados.totalCiclos, 1); assert.equal(dados.cicloAtual.id, leitura.id);
    assert.deepEqual(dados.cicloAtual.indicadores, { participantes: 1, leiturasConcluidas: 0, taxaConclusao: 0, progressoMedio: 0 });
    assert.equal(dados.livrosMaisUtilizados.meta.total, 1); assert.equal(dados.leitoresSemParticipacao.meta.total, 0);
    const seguinte = await consultar(administrador); assert.equal(seguinte.totalLivros, 2); assert.equal(seguinte.totalCiclos, 2);
    assert.equal(seguinte.cicloAtual.id, novaLeitura.id); assert.equal(seguinte.cicloAtual.indicadores.participantes, 0);
    assert.deepEqual(seguinte.leitoresSemParticipacao.data.map((pessoa) => pessoa.id), [novoLeitor.id]);
  });

  it('falha do banco retorna 503 seguro e parâmetros de consulta desconhecidos são recusados', async (contexto) => {
    const administrador = await entrar();
    assert.equal((await administrador.get('/api/dashboard/admin').query({ cicloId: 123 })).status, 422);
    const original = conexao.query;
    contexto.mock.method(conexao, 'query', async function (sql, opcoes) {
      if (sql === carregarConsulta('totaisDashboard')) throw new ConnectionError(new Error('SQL e credencial privados'));
      return original.call(this, sql, opcoes);
    });
    const resposta = await administrador.get('/api/dashboard/admin'); assert.equal(resposta.status, 503);
    assert.deepEqual(resposta.body, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Serviço temporariamente indisponível.' } });
  });

  it('dashboard pessoal exige leitor ativo e recusa seleção de identidade em query, corpo ou caminho', async () => {
    const outro = await usuario(); const agente = await entrar(leitor);
    assert.equal((await supertest(app).get('/api/dashboard/me')).status, 401);
    assert.equal((await (await entrar()).get('/api/dashboard/me')).status, 403);
    assert.equal((await agente.get('/api/dashboard/me').query({ usuarioId: outro.id })).status, 422);
    assert.equal((await agente.get('/api/dashboard/me').send({ usuarioId: outro.id })).status, 422);
    assert.equal((await agente.get(`/api/dashboard/me/${outro.id}`)).status, 404);
    const vazio = await consultarMeu(agente);
    assert.equal(vazio.totalParticipacoes, 0); assert.equal(vazio.leiturasConcluidas, 0);
    assert.equal(vazio.cicloAtual, null); assert.equal(vazio.minhaParticipacao, null);
    assert.equal(vazio.totalInscricoesFuturas, 0); assert.deepEqual(vazio.agendaFutura, []);
    await leitor.update({ situacao: 'INATIVO', sessionVersion: 1 });
    assert.equal((await agente.get('/api/dashboard/me')).status, 401);
    assert.equal(chamadasRelogio, 1);
  });

  it('dois leitores recebem apenas seus totais, progresso e inscrições', async () => {
    const outro = await usuario(); const obra = await livro(); const atual = await ciclo(obra); const anterior = await ciclo(obra, 'CONCLUIDO');
    await participacao(leitor, atual, 150); await participacao(leitor, anterior, 300); await participacao(outro, atual, 300);
    const primeiro = await encontro(atual, '2026-11-03T12:00:00Z'); const segundo = await encontro(atual, '2026-11-03T13:00:00Z');
    await inscricao(leitor, primeiro); await inscricao(outro, segundo);
    const a = await consultarMeu(await entrar(leitor)); const b = await consultarMeu(await entrar(outro));
    assert.equal(a.generatedAt, '2026-11-02T15:00:00.000Z'); assert.equal(b.generatedAt, a.generatedAt); assert.equal(chamadasRelogio, 2);
    assert.equal(a.totalParticipacoes, 2); assert.equal(a.leiturasConcluidas, 1);
    assert.equal(b.totalParticipacoes, 1); assert.equal(b.leiturasConcluidas, 1);
    assert.equal(a.cicloAtual.id, atual.id); assert.equal(a.cicloAtual.livro.id, obra.id); assert.equal(a.cicloAtual.dentroDoPeriodo, true);
    assert.equal(a.minhaParticipacao.paginaAtual, 150); assert.equal(a.minhaParticipacao.totalPaginas, 300);
    assert.equal(a.minhaParticipacao.percentual, 50); assert.equal(a.minhaParticipacao.concluida, false);
    assert.equal(a.minhaParticipacao.concluidaEm, null); assert.equal(a.minhaParticipacao.podeAtualizarProgresso, true);
    assert.equal(b.minhaParticipacao.percentual, 100); assert.equal(b.minhaParticipacao.concluida, true);
    assert.deepEqual(a.agendaFutura.map((item) => item.encontro.id), [primeiro.id]);
    assert.deepEqual(b.agendaFutura.map((item) => item.encontro.id), [segundo.id]);
    for (const dados of [a, b]) for (const valor of [dados.totalParticipacoes, dados.leiturasConcluidas, dados.totalInscricoesFuturas,
      dados.minhaParticipacao.paginaAtual, dados.minhaParticipacao.totalPaginas, dados.minhaParticipacao.percentual]) assert.equal(typeof valor, 'number');
  });

  it('histórico e contagens pessoais permanecem sem ciclo atual, sem usar planejado como substituto', async () => {
    const outro = await usuario(); const obra = await livro();
    const encerrado = await ciclo(obra, 'CONCLUIDO'); const planejado = await ciclo(obra, 'PLANEJADO');
    await participacao(leitor, encerrado, 300); await participacao(leitor, planejado, 150); await participacao(outro, encerrado, 300);
    const evento = await encontro(planejado, '2026-11-03T12:00:00Z'); await inscricao(leitor, evento);
    const dados = await consultarMeu(await entrar(leitor));
    assert.equal(dados.totalParticipacoes, 2); assert.equal(dados.leiturasConcluidas, 1);
    assert.equal(dados.cicloAtual, null); assert.equal(dados.minhaParticipacao, null);
    assert.equal(dados.totalInscricoesFuturas, 1); assert.equal(dados.agendaFutura[0].encontro.id, evento.id);
    await planejado.reload(); assert.equal(planejado.situacao, 'PLANEJADO');
  });

  it('sem adesão ao ciclo atual, minhaParticipacao é null e GET não cria participação', async () => {
    const outro = await usuario(); const atual = await ciclo(await livro()); await participacao(outro, atual, 300);
    const agente = await entrar(leitor);
    for (let i = 0; i < 2; i += 1) {
      const dados = await consultarMeu(agente); assert.equal(dados.cicloAtual.id, atual.id);
      assert.equal(dados.minhaParticipacao, null); assert.equal(dados.totalParticipacoes, 0); assert.equal(dados.leiturasConcluidas, 0);
    }
    assert.equal(await conexao.models.ParticipacaoLeitura.count(), 1);
    assert.equal(await conexao.models.ParticipacaoLeitura.count({ where: { usuarioId: leitor.id } }), 0);
  });

  it('indicação de progresso respeita período de São Paulo e conclusão exata apesar do arredondamento', async () => {
    const atual = await ciclo(await livro(20000), 'EM_ANDAMENTO', { dataFim: '2026-11-02' });
    await participacao(leitor, atual, 19999); const agente = await entrar(leitor);
    for (const [agora, permitido] of [['2026-11-02T02:59:59.999Z', false], ['2026-11-02T03:00:00Z', true],
      ['2026-11-03T02:59:59.999Z', true], ['2026-11-03T03:00:00Z', false]]) {
      instante = Date.parse(agora); const dados = await consultarMeu(agente);
      assert.equal(dados.generatedAt, new Date(instante).toISOString());
      assert.equal(dados.minhaParticipacao.podeAtualizarProgresso, permitido);
      assert.equal(dados.minhaParticipacao.percentual, 100); assert.equal(dados.minhaParticipacao.concluida, false); assert.equal(dados.leiturasConcluidas, 0);
    }
    // A indicação não autoriza a escrita: o serviço reconfere o período atual.
    const token = await csrf(agente);
    assert.equal((await agente.patch(`/api/ciclos/${atual.id}/meu-progresso`).set('X-CSRF-Token', token).send({ paginaAtual: 20000 })).status, 409);
    await atual.update({ situacao: 'CONCLUIDO' });
    const encerrado = await consultarMeu(agente); assert.equal(encerrado.cicloAtual, null); assert.equal(encerrado.minhaParticipacao, null); assert.equal(encerrado.totalParticipacoes, 1);
  });

  it('agenda retorna cinco inscrições por início e id, total sem limite e exclui cancelados, realizados, passados e removidos', async () => {
    const outro = await usuario(); const atual = await ciclo(await livro());
    const eventos = [];
    for (let i = 0; i < 7; i += 1) eventos.push(await encontro(atual, `2026-11-02T${i < 3 ? '16' : String(14 + i)}:00:00Z`));
    const inscritas = [];
    for (const indice of [2, 0, 1, 6, 5, 3, 4]) inscritas.push(await inscricao(leitor, eventos[indice]));
    for (const [inicio, situacao] of [['2026-11-02T15:00:00Z', 'AGENDADO'], ['2026-11-02T14:59:59Z', 'AGENDADO'],
      ['2026-11-03T12:00:00Z', 'CANCELADO'], ['2026-11-03T13:00:00Z', 'REALIZADO']]) await inscricao(leitor, await encontro(atual, inicio, situacao));
    const removido = await encontro(atual, '2026-11-03T14:00:00Z'); await inscricao(leitor, removido);
    await inscricao(outro, await encontro(atual, '2026-11-02T15:30:00Z'));
    const administrador = await entrar();
    const tokenAdmin = await csrf(administrador);
    assert.equal((await administrador.delete(`/api/encontros/${removido.id}`).set('X-CSRF-Token', tokenAdmin)).status, 204);
    assert.equal(await conexao.models.InscricaoEncontro.count({ where: { encontroId: removido.id } }), 0);
    const agente = await entrar(leitor); const dados = await consultarMeu(agente);
    assert.equal(dados.totalInscricoesFuturas, 7); assert.equal(dados.agendaFutura.length, 5);
    const esperadas = [...inscritas].sort((a, b) => {
      const ea = eventos.find((evento) => evento.id === a.encontroId); const eb = eventos.find((evento) => evento.id === b.encontroId);
      return ea.inicioEm - eb.inicioEm || a.id - b.id;
    });
    assert.deepEqual(dados.agendaFutura.map((item) => item.id), esperadas.slice(0, 5).map((item) => item.id));
    assert.ok(dados.agendaFutura.every((item) => item.encontro.situacao === 'AGENDADO'));
    // O filtro interno novo não altera o contrato da listagem pessoal anterior.
    const historico = await agente.get('/api/me/inscricoes').query({ futuros: 'true' });
    assert.equal(historico.status, 200); assert.equal(historico.body.meta.total, 9);
    assert.ok(historico.body.data.some((item) => item.encontro.situacao === 'CANCELADO'));
  });

  it('recalcula após adesão, progresso, inscrição, cancelamento, exclusão e conclusão pelas APIs reais', async () => {
    const atual = await ciclo(await livro()); const primeiro = await encontro(atual, '2026-11-03T12:00:00Z'); const segundo = await encontro(atual, '2026-11-03T13:00:00Z');
    const agente = await entrar(leitor); const administrador = await entrar(); const token = await csrf(agente); const tokenAdmin = await csrf(administrador);
    assert.equal((await consultarMeu(agente)).minhaParticipacao, null);
    assert.equal((await agente.post(`/api/ciclos/${atual.id}/participacoes`).set('X-CSRF-Token', token)).status, 201);
    assert.equal((await consultarMeu(agente)).totalParticipacoes, 1);
    assert.equal((await agente.patch(`/api/ciclos/${atual.id}/meu-progresso`).set('X-CSRF-Token', token).send({ paginaAtual: 300 })).status, 200);
    const completo = await consultarMeu(agente); assert.equal(completo.leiturasConcluidas, 1); assert.equal(completo.minhaParticipacao.concluida, true);
    assert.equal((await agente.patch(`/api/ciclos/${atual.id}/meu-progresso`).set('X-CSRF-Token', token).send({ paginaAtual: 150 })).status, 200);
    const recuo = await consultarMeu(agente); assert.equal(recuo.leiturasConcluidas, 0); assert.equal(recuo.minhaParticipacao.percentual, 50); assert.equal(recuo.minhaParticipacao.concluidaEm, null);
    assert.equal((await agente.post(`/api/encontros/${primeiro.id}/inscricoes`).set('X-CSRF-Token', token)).status, 201);
    assert.equal((await consultarMeu(agente)).totalInscricoesFuturas, 1);
    assert.equal((await agente.delete(`/api/encontros/${primeiro.id}/minha-inscricao`).set('X-CSRF-Token', token)).status, 204);
    assert.equal((await consultarMeu(agente)).totalInscricoesFuturas, 0);
    for (const evento of [primeiro, segundo]) assert.equal((await agente.post(`/api/encontros/${evento.id}/inscricoes`).set('X-CSRF-Token', token)).status, 201);
    assert.equal((await consultarMeu(agente)).totalInscricoesFuturas, 2);
    assert.equal((await administrador.patch(`/api/encontros/${primeiro.id}`).set('X-CSRF-Token', tokenAdmin).send({ situacao: 'CANCELADO' })).status, 200);
    assert.equal((await consultarMeu(agente)).totalInscricoesFuturas, 1);
    assert.equal((await administrador.delete(`/api/encontros/${segundo.id}`).set('X-CSRF-Token', tokenAdmin)).status, 204);
    assert.equal((await consultarMeu(agente)).totalInscricoesFuturas, 0);
    assert.equal((await administrador.patch(`/api/ciclos/${atual.id}`).set('X-CSRF-Token', tokenAdmin).send({ situacao: 'CONCLUIDO' })).status, 200);
    const encerrado = await consultarMeu(agente); assert.equal(encerrado.cicloAtual, null); assert.equal(encerrado.minhaParticipacao, null); assert.equal(encerrado.totalParticipacoes, 1);
  });

  it('GET pessoal preserva domínio e sessão persistida, não renova prazo absoluto e recusa cookie expirado', async () => {
    const atual = await ciclo(await livro()); await participacao(leitor, atual, 150);
    await inscricao(leitor, await encontro(atual, '2026-11-03T12:00:00Z'));
    const agente = await entrar(leitor);
    const sessao = async () => (await pool.query("SELECT sid, sess, expire FROM sessoes WHERE sess->'passport'->'user'->>'id' = $1", [String(leitor.id)])).rows;
    const dominio = async () => {
      const dados = [];
      for (const modelo of ['Usuario', 'Genero', 'Livro', 'CicloLeitura', 'Encontro', 'ParticipacaoLeitura', 'InscricaoEncontro']) dados.push(await conexao.models[modelo].findAll({ order: [['id', 'ASC']], raw: true }));
      return dados;
    };
    const antes = await sessao(); assert.equal(antes.length, 1); const dadosAntes = await dominio();
    relogioAutenticacao += 5 * 60 * 1000;
    const resposta = await agente.get('/api/dashboard/me'); assert.equal(resposta.status, 200); assert.equal(resposta.headers['set-cookie'], undefined);
    await consultarMeu(agente); assert.deepEqual(await sessao(), antes); assert.deepEqual(await dominio(), dadosAntes);
    relogioAutenticacao = antes[0].sess.expiraEm;
    const expirada = await agente.get('/api/dashboard/me'); assert.equal(expirada.status, 401); assert.equal(expirada.body.data, undefined);
  });

  it('dashboard pessoal mantém um snapshot durante commit de progresso, histórico, agenda e ciclo', async (contexto) => {
    const obra = await livro(); const atual = await ciclo(obra); const propria = await participacao(leitor, atual, 150);
    const evento = await encontro(atual, '2026-11-03T12:00:00Z'); await inscricao(leitor, evento);
    const agente = await entrar(leitor); let sinalizar; let liberar; let interceptar = true;
    const pronta = new Promise((resolver) => { sinalizar = resolver; }); const liberada = new Promise((resolver) => { liberar = resolver; });
    const original = conexao.query;
    contexto.mock.method(conexao, 'query', async function (sql, opcoes) {
      const resultado = await original.call(this, sql, opcoes);
      if (interceptar && sql === carregarConsulta('totaisLeitor')) { interceptar = false; sinalizar(); await liberada; }
      return resultado;
    });
    const pedido = agente.get('/api/dashboard/me').then((resposta) => resposta); let prazo; let novoCiclo;
    try {
      await Promise.race([pronta, new Promise((_, rejeitar) => { prazo = setTimeout(() => rejeitar(new Error('Snapshot pessoal não foi alcançado.')), 5000); })]);
      await conexao.transaction(async (transaction) => {
        await propria.update({ paginaAtual: 300, concluidaEm: new Date(instante) }, { transaction });
        await participacao(leitor, await ciclo(obra, 'CONCLUIDO', {}, transaction), 300, transaction);
        await evento.destroy({ transaction }); await atual.update({ situacao: 'CONCLUIDO' }, { transaction });
        novoCiclo = await ciclo(await livro(300, transaction), 'EM_ANDAMENTO', {}, transaction);
      });
    } finally { clearTimeout(prazo); liberar(); }
    const resposta = await pedido; assert.equal(resposta.status, 200); const dados = resposta.body.data;
    assert.equal(dados.totalParticipacoes, 1); assert.equal(dados.leiturasConcluidas, 0); assert.equal(dados.cicloAtual.id, atual.id);
    assert.equal(dados.minhaParticipacao.paginaAtual, 150); assert.equal(dados.totalInscricoesFuturas, 1); assert.equal(dados.agendaFutura[0].encontro.id, evento.id);
    assert.equal(chamadasRelogio, 1);
    const seguinte = await consultarMeu(agente); assert.equal(seguinte.totalParticipacoes, 2); assert.equal(seguinte.leiturasConcluidas, 2);
    assert.equal(seguinte.cicloAtual.id, novoCiclo.id); assert.equal(seguinte.minhaParticipacao, null); assert.equal(seguinte.totalInscricoesFuturas, 0); assert.deepEqual(seguinte.agendaFutura, []);
  });

  it('falhas nas contagens e na agenda pessoal retornam 503 seguro, sem preencher zeros ou resposta parcial', async (contexto) => {
    const agente = await entrar(leitor); const original = conexao.query;
    for (const consulta of ['totaisLeitor', 'contarAgenda']) {
      const simulada = contexto.mock.method(conexao, 'query', async function (sql, opcoes) {
        if (sql === carregarConsulta(consulta)) throw new ConnectionError(new Error('SQL e senha privados'));
        return original.call(this, sql, opcoes);
      });
      try {
        const resposta = await agente.get('/api/dashboard/me'); assert.equal(resposta.status, 503); assert.equal(resposta.body.data, undefined);
        assert.deepEqual(resposta.body, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Serviço temporariamente indisponível.' } });
      } finally { simulada.mock.restore(); }
    }
    assert.equal((await consultarMeu(agente)).totalParticipacoes, 0);
  });

  it('app.js monta os dois dashboards com autenticação real e envelope de detalhe', async (contexto) => {
    const banco = require('../../database/conexao'); const servicoAutenticacao = require('../../autenticacao/servico');
    contexto.mock.method(banco, 'obterConexao', () => conexao);
    contexto.mock.method(servicoAutenticacao, 'identificarRequisicao', autenticacao.identificar);
    contexto.mock.method(servicoAutenticacao, 'atenderAutenticacao', autenticacao.roteador);
    const publico = require('../../app');
    assert.equal((await supertest(publico).get('/api/dashboard/admin')).status, 401);
    const dados = await consultar(await entrar(gestor, publico)); assert.equal(dados.cicloAtual, null); assert.equal(dados.totalLivros, 0);
    assert.equal((await supertest(publico).get('/api/dashboard/me')).status, 401);
    const pessoais = await consultarMeu(await entrar(leitor, publico)); assert.equal(pessoais.totalParticipacoes, 0); assert.equal(pessoais.minhaParticipacao, null);
  });
});
