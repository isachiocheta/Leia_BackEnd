'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const bcrypt = require('bcrypt');
const express = require('express');
const supertest = require('supertest');
const { Pool } = require('pg');
const { criarConexao } = require('../../database/conexao');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { carregarConfiguracaoSessao } = require('../../configuracao/sessao');
const { criarAutenticacao } = require('../../autenticacao/rotas');
const { criarRotasEncontros } = require('../../encontros/rotas');
const { criarRotasPerfil } = require('../../perfil/rotas');
const { configurarHttp } = require('../../intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('../../intermediarios/erros');
const { reservarCiclosAtivos } = require('../apoio/coordenacao-ciclos');
const { dataEmSaoPaulo } = require('../../utilitarios/datas-civis');

const destino = validarBancoTeste(process.env);
const configuracao = carregarConfiguracaoSessao({ NODE_ENV: 'test', SESSION_SECRET: 'Segredo exclusivo das fixtures HTTP de inscrições Leia+', SESSION_COOKIE_SECURE: 'false' });
const senha = 'Senha das fixtures de inscrições';
const prefixo = `inscricoes-http-${process.pid}-${Date.now()}`;

describe('Inscrições HTTP com PostgreSQL e sessões reais', { timeout: 60_000 }, () => {
  let conexao; let hash; let liberarCiclos; let sequencia = 0;
  const ids = Object.fromEntries(['Usuario', 'Genero', 'Livro', 'CicloLeitura', 'Encontro', 'ParticipacaoLeitura', 'InscricaoEncontro'].map((modelo) => [modelo, new Set()]));
  const sids = new Set();
  before(async () => { liberarCiclos = await reservarCiclosAtivos(); conexao = criarConexao(); validarDestinoTeste(conexao); await conexao.authenticate(); hash = await bcrypt.hash(senha, 4); });
  after(async () => {
    try {
      if (conexao) {
        try {
          validarDestinoTeste(conexao); await conexao.query('DELETE FROM sessoes WHERE sid = ANY($1::varchar[])', { bind: [[...sids]] });
          for (const modelo of ['InscricaoEncontro', 'ParticipacaoLeitura', 'Encontro', 'CicloLeitura', 'Livro', 'Genero', 'Usuario']) {
            validarDestinoTeste(conexao); if (ids[modelo].size) await conexao.models[modelo].destroy({ where: { id: [...ids[modelo]] } });
          }
        } finally { await conexao.close(); }
      }
    } finally { if (liberarCiclos) await liberarCiclos(); }
  });
  async function criar(modelo, dados) { const registro = await conexao.models[modelo].create(dados); ids[modelo].add(registro.id); return registro; }
  async function ciclo(extras = {}) {
    sequencia += 1; const genero = await criar('Genero', { nome: `${prefixo}-${sequencia}` });
    const livro = await criar('Livro', { titulo: 'Obra das inscrições', autor: 'Autora', generoId: genero.id, totalPaginas: 100 });
    return criar('CicloLeitura', { nome: 'Ciclo das inscrições', livroId: livro.id, dataInicio: '2026-11-01', dataFim: '2026-11-03', situacao: 'EM_ANDAMENTO', ...extras });
  }
  function encontro(cicloId, extras = {}) { return criar('Encontro', { cicloId, titulo: 'Encontro das inscrições', inicioEm: '2026-11-02T15:00:00Z', local: 'Biblioteca', ...extras }); }
  function usuario(perfil = 'LEITOR') {
    sequencia += 1; return criar('Usuario', { nome: `Pessoa ${sequencia}`, email: `${prefixo}-${sequencia}@escola.example`, senhaHash: hash, perfil, situacao: 'ATIVO', sessionVersion: 0 });
  }
  function participar(pessoa, origem) { return criar('ParticipacaoLeitura', { usuarioId: pessoa.id, cicloId: origem.id, paginaAtual: 0 }); }
  function registrar(resposta) {
    for (const cookie of resposta.headers['set-cookie'] || []) {
      const valor = decodeURIComponent(cookie.split(';')[0].slice('leia.sid='.length));
      if (cookie.startsWith('leia.sid=') && valor.startsWith('s:')) sids.add(valor.slice(2, valor.lastIndexOf('.')));
    }
    assert.doesNotMatch(JSON.stringify(resposta.body), /senhaHash|senha_hash|sessionVersion|session_version|"sql"|"stack"|presenca|lotacao|listaEspera/); return resposta;
  }
  async function token(agente) { const resposta = registrar(await agente.get('/api/auth/csrf')); assert.equal(resposta.status, 200); return resposta.body.data.csrfToken; }
  async function entrar(agente, conta = null) {
    const pessoa = conta || await usuario(); const csrf = await token(agente);
    assert.equal(registrar(await agente.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email: pessoa.email, senha })).status, 200);
    return { conta: pessoa, csrf: await token(agente) };
  }
  async function inscrever(agente, csrf, id, corpo) {
    const pedido = agente.post(`/api/encontros/${id}/inscricoes`).set('X-CSRF-Token', csrf); if (corpo !== undefined) pedido.send(corpo);
    const resposta = registrar(await pedido); if (resposta.status === 201) ids.InscricaoEncontro.add(resposta.body.data.id); return resposta;
  }
  async function cancelar(agente, csrf, id, corpo) {
    const pedido = agente.delete(`/api/encontros/${id}/minha-inscricao`).set('X-CSRF-Token', csrf); if (corpo !== undefined) pedido.send(corpo);
    return registrar(await pedido);
  }
  async function editar(agente, csrf, id, dados) { return registrar(await agente.patch(`/api/encontros/${id}`).set('X-CSRF-Token', csrf).send(dados)); }
  async function excluir(agente, csrf, id) { return registrar(await agente.delete(`/api/encontros/${id}`).set('X-CSRF-Token', csrf)); }
  async function emAplicacao(executar, { agora = () => Date.parse('2026-11-01T15:00:00Z') } = {}) {
    const pool = new Pool({ connectionString: destino.url, max: 3 }); const autenticacao = criarAutenticacao({ configuracao, pool, obterUsuario: () => conexao.models.Usuario });
    const app = express(); configurarHttp(app, { origemPermitida: 'http://localhost:5173' }); app.use('/api/auth', autenticacao.roteador);
    app.use('/api/encontros', autenticacao.identificar, criarRotasEncontros({ obterConexao: () => conexao, agora }));
    app.use('/api/me', autenticacao.identificar, criarRotasPerfil({ obterUsuario: () => conexao.models.Usuario, obterConexao: () => conexao, agora }));
    app.use(rotaNaoEncontrada); app.use(tratarErros);
    try { await executar({ app, agente: supertest.agent(app) }); }
    finally {
      // Limpeza exclusiva das fixtures para liberar o índice global entre casos.
      validarDestinoTeste(conexao); await conexao.models.CicloLeitura.update({ situacao: 'CONCLUIDO' }, { where: { id: [...ids.CicloLeitura], situacao: 'EM_ANDAMENTO' } });
      await autenticacao.encerrar(); await pool.end();
    }
  }
  function barreira() {
    let sinalizar; let liberar; const pronta = new Promise((resolver) => { sinalizar = resolver; }); const liberada = new Promise((resolver) => { liberar = resolver; });
    return { pronta, liberar, async parar() { sinalizar(); await liberada; } };
  }
  async function aguardar(sinal) {
    let prazo; try { await Promise.race([sinal, new Promise((_, rejeitar) => { prazo = setTimeout(() => rejeitar(new Error('A mutação não atingiu o ponto de sincronização.')), 3000); })]); }
    finally { clearTimeout(prazo); }
  }

  it('duas sessões geram uma inscrição e um 409; cancelamento próprio concorrente retorna 204 e 404', async () => {
    const origem = await ciclo(); const evento = await encontro(origem.id); const pessoa = await usuario(); await participar(pessoa, origem);
    await emAplicacao(async ({ app, agente }) => {
      const outra = supertest.agent(app); const a = await entrar(agente, pessoa); const b = await entrar(outra, pessoa);
      const respostas = await Promise.all([inscrever(agente, a.csrf, evento.id), inscrever(outra, b.csrf, evento.id, {})]);
      assert.deepEqual(respostas.map((resposta) => resposta.status).sort(), [201, 409]);
      const criada = respostas.find((resposta) => resposta.status === 201).body.data;
      assert.equal(criada.encontro.id, evento.id); assert.equal(criada.encontro.inicioEm, evento.inicioEm.toISOString());
      assert.equal(criada.ciclo.id, origem.id); assert.equal(criada.livro.id, origem.livroId);
      assert.equal(registrar(await agente.get(`/api/encontros/${evento.id}`)).body.data.quantidadeInscritos, 1);
      const canceladas = await Promise.all([cancelar(agente, a.csrf, evento.id), cancelar(outra, b.csrf, evento.id)]);
      assert.deepEqual(canceladas.map((resposta) => resposta.status).sort(), [204, 404]);
      const vazia = canceladas.find((resposta) => resposta.status === 204); assert.equal(vazia.text, ''); assert.equal(vazia.headers['content-type'], undefined); assert.equal(vazia.headers['content-length'], undefined);
      assert.equal(registrar(await agente.get(`/api/encontros/${evento.id}`)).body.data.quantidadeInscritos, 0);
      assert.equal(await conexao.models.ParticipacaoLeitura.count({ where: { usuarioId: pessoa.id, cicloId: origem.id } }), 1);
    });
  });

  it('exige participação no mesmo ciclo, titularidade, perfil ativo, corpo vazio e CSRF', async () => {
    const origem = await ciclo(); const outraOrigem = await ciclo({ situacao: 'PLANEJADO' }); const evento = await encontro(origem.id); const pessoa = await usuario();
    await participar(pessoa, outraOrigem);
    await emAplicacao(async ({ app, agente }) => {
      assert.equal(registrar(await agente.post(`/api/encontros/${evento.id}/inscricoes`)).status, 401);
      assert.equal(registrar(await agente.delete(`/api/encontros/${evento.id}/minha-inscricao`)).status, 401);
      const { csrf } = await entrar(agente, pessoa);
      assert.equal((await inscrever(agente, csrf, evento.id)).status, 403);
      const semAdesao = supertest.agent(app); const sem = await entrar(semAdesao);
      assert.equal((await inscrever(semAdesao, sem.csrf, evento.id)).status, 403);
      const titular = await usuario(); await participar(titular, origem); const outro = supertest.agent(app); const b = await entrar(outro, titular);
      assert.equal((await inscrever(outro, b.csrf, evento.id)).status, 201);
      assert.equal((await cancelar(agente, csrf, evento.id)).status, 404);
      await participar(pessoa, origem);
      for (const corpo of [{ usuarioId: titular.id }, { encontroId: evento.id }, { presenca: true }, { lotacao: 1 }]) assert.equal((await inscrever(agente, csrf, evento.id, corpo)).status, 422);
      assert.equal(registrar(await agente.post(`/api/encontros/${evento.id}/inscricoes`).set('X-CSRF-Token', csrf).query({ usuarioId: titular.id })).status, 422);
      assert.equal(registrar(await agente.post(`/api/encontros/${evento.id}/inscricoes`)).status, 403);
      assert.equal((await inscrever(agente, csrf, evento.id)).status, 201);
      assert.equal((await cancelar(agente, csrf, evento.id, { usuarioId: titular.id })).status, 422);
      assert.equal(registrar(await agente.delete(`/api/encontros/${evento.id}/minha-inscricao`)).status, 403);
      assert.equal(registrar(await agente.get(`/api/encontros/${evento.id}/inscritos`)).status, 403);
      const administrador = supertest.agent(app); const admin = await entrar(administrador, await usuario('ADMIN_CLUBE'));
      assert.equal((await inscrever(administrador, admin.csrf, evento.id)).status, 403); assert.equal((await cancelar(administrador, admin.csrf, evento.id)).status, 403);
      await pessoa.update({ situacao: 'INATIVO', sessionVersion: 1 }); assert.equal((await cancelar(agente, csrf, evento.id)).status, 401);
      assert.equal(await conexao.models.InscricaoEncontro.count({ where: { encontroId: evento.id } }), 2);
    });
  });

  it('estados, prazo e ciclo são revalidados tanto para inscrever quanto para cancelar', async () => {
    const origem = await ciclo(); const pessoa = await usuario(); await participar(pessoa, origem);
    const invalidos = [await encontro(origem.id, { inicioEm: '2026-11-01T15:00:00Z' }), await encontro(origem.id, { situacao: 'REALIZADO' }), await encontro(origem.id, { situacao: 'CANCELADO' })];
    for (const situacao of ['PLANEJADO', 'CONCLUIDO']) {
      const outro = await ciclo({ situacao }); await participar(pessoa, outro); invalidos.push(await encontro(outro.id));
    }
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente, pessoa);
      for (const evento of invalidos) {
        assert.equal((await inscrever(agente, csrf, evento.id)).status, 409);
        assert.equal((await cancelar(agente, csrf, evento.id)).status, 404);
        const antiga = await criar('InscricaoEncontro', { usuarioId: pessoa.id, encontroId: evento.id });
        assert.equal((await cancelar(agente, csrf, evento.id)).status, 409); assert.ok(await antiga.reload());
      }
      assert.equal((await inscrever(agente, csrf, 2147483647)).status, 404);
      assert.equal((await cancelar(agente, csrf, 2147483647)).status, 404);
    });
  });

  it('listagem própria preserva histórico, filtra futuros e administração usa dados mínimos paginados', async () => {
    const origem = await ciclo(); const pessoa = await usuario(); const outra = await usuario();
    const eventos = [
      await encontro(origem.id, { inicioEm: '2026-11-01T12:00:00Z', situacao: 'REALIZADO' }),
      await encontro(origem.id, { inicioEm: '2026-11-01T15:00:00Z' }),
      await encontro(origem.id), await encontro(origem.id, { inicioEm: '2026-11-03T15:00:00Z', situacao: 'CANCELADO' }),
    ];
    for (const evento of eventos) await criar('InscricaoEncontro', { usuarioId: pessoa.id, encontroId: evento.id });
    await criar('InscricaoEncontro', { usuarioId: outra.id, encontroId: eventos[2].id });
    await emAplicacao(async ({ app, agente }) => {
      await entrar(agente, pessoa);
      const todas = registrar(await agente.get('/api/me/inscricoes')); assert.equal(todas.status, 200); assert.equal(todas.body.meta.total, 4); assert.equal(todas.body.meta.pageSize, 12);
      assert.equal(todas.body.data[0].encontro.situacao, 'REALIZADO'); assert.equal(todas.body.data[0].encontro.inicioEm, '2026-11-01T12:00:00.000Z');
      assert.equal(todas.body.data[0].encontro.local, 'Biblioteca'); assert.equal(todas.body.data[0].ciclo.id, origem.id); assert.equal(todas.body.data[0].livro.id, origem.livroId);
      const futuras = registrar(await agente.get('/api/me/inscricoes').query({ futuros: true })); assert.equal(futuras.body.meta.total, 2); assert.equal(futuras.body.data[1].encontro.situacao, 'CANCELADO');
      const segunda = registrar(await agente.get('/api/me/inscricoes').query({ pageSize: 1, page: 2, futuros: false })); assert.deepEqual(segunda.body.meta, { page: 2, pageSize: 1, total: 4 }); assert.equal(segunda.body.data[0].encontro.id, eventos[1].id);
      for (const consulta of [{ usuarioId: outra.id }, { futuros: '1' }, { futuros: ['true', 'false'] }, { pageSize: 51 }]) assert.equal(registrar(await agente.get('/api/me/inscricoes').query(consulta)).status, 422);
      const outro = supertest.agent(app); await entrar(outro, outra); assert.equal(registrar(await outro.get('/api/me/inscricoes')).body.meta.total, 1);
      const administrador = supertest.agent(app); await entrar(administrador, await usuario('ADMIN_CLUBE'));
      const lista = registrar(await administrador.get(`/api/encontros/${eventos[2].id}/inscritos`).query({ pageSize: 1, page: 2 }));
      assert.equal(lista.status, 200); assert.deepEqual(lista.body.meta, { page: 2, pageSize: 1, total: 2 }); assert.deepEqual(Object.keys(lista.body.data[0].usuario).sort(), ['id', 'nome']); assert.equal(lista.body.data[0].usuario.id, outra.id);
      assert.equal(registrar(await administrador.get('/api/encontros/2147483647/inscritos')).status, 404);
      await origem.update({ situacao: 'CONCLUIDO' }); assert.equal(registrar(await agente.get('/api/me/inscricoes')).body.meta.total, 4);
    });
  });

  it('dia final de São Paulo é inclusivo, encontro no início exato fecha a janela e histórico permanece', async () => {
    const origem = await ciclo(); const evento = await encontro(origem.id, { inicioEm: '2026-11-04T02:59:59.999Z' }); const pessoa = await usuario(); await participar(pessoa, origem);
    let agora = Date.parse('2026-11-04T02:59:59.000Z');
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente, pessoa); assert.equal((await inscrever(agente, csrf, evento.id)).status, 201);
      agora = evento.inicioEm.getTime(); assert.equal((await cancelar(agente, csrf, evento.id)).status, 409);
      agora = Date.parse('2026-11-04T03:00:00Z'); assert.equal((await cancelar(agente, csrf, evento.id)).status, 409);
      assert.equal(registrar(await agente.get('/api/me/inscricoes')).body.meta.total, 1); assert.equal(registrar(await agente.get('/api/me/inscricoes').query({ futuros: true })).body.meta.total, 0);
      assert.equal(await conexao.models.InscricaoEncontro.count({ where: { usuarioId: pessoa.id } }), 1);
    }, { agora: () => agora });
  });

  it('inscrição primeiro bloqueia troca de ciclo; cancelamento administrativo preserva intenção e ganha a corrida quando ocorre primeiro', async (contexto) => {
    const origem = await ciclo(); const destino = await ciclo({ situacao: 'PLANEJADO' }); const a = await encontro(origem.id); const b = await encontro(origem.id); const pessoa = await usuario(); await participar(pessoa, origem);
    await emAplicacao(async ({ app, agente }) => {
      const { csrf } = await entrar(agente, pessoa); const administrador = supertest.agent(app); const admin = await entrar(administrador, await usuario('ADMIN_CLUBE'));
      const primeira = barreira(); const criarOriginal = conexao.models.InscricaoEncontro.create;
      contexto.mock.method(conexao.models.InscricaoEncontro, 'create', async function (dados, opcoes) { if (dados.encontroId === a.id) await primeira.parar(); return criarOriginal.call(this, dados, opcoes); });
      const inscricao = inscrever(agente, csrf, a.id);
      try {
        await aguardar(primeira.pronta); const troca = editar(administrador, admin.csrf, a.id, { cicloId: destino.id }); primeira.liberar();
        const respostas = await Promise.all([inscricao, troca]); assert.equal(respostas[0].status, 201); assert.equal(respostas[1].status, 409);
        assert.equal((await editar(administrador, admin.csrf, a.id, { situacao: 'CANCELADO' })).status, 200);
        assert.equal(registrar(await agente.get('/api/me/inscricoes')).body.data[0].encontro.situacao, 'CANCELADO');
      } finally { primeira.liberar(); }
      const segunda = barreira(); const atualizarOriginal = conexao.models.Encontro.prototype.update;
      contexto.mock.method(conexao.models.Encontro.prototype, 'update', async function (dados, opcoes) { if (this.id === b.id) await segunda.parar(); return atualizarOriginal.call(this, dados, opcoes); });
      const cancelamento = editar(administrador, admin.csrf, b.id, { situacao: 'CANCELADO' });
      try {
        await aguardar(segunda.pronta); const tentativa = inscrever(agente, csrf, b.id); segunda.liberar();
        const respostas = await Promise.all([cancelamento, tentativa]); assert.equal(respostas[0].status, 200); assert.equal(respostas[1].status, 409);
        assert.equal(await conexao.models.InscricaoEncontro.count({ where: { encontroId: b.id } }), 0);
      } finally { segunda.liberar(); }
    });
  });

  it('reagendamento relido usa o novo instante e troca concorrente nunca inscreve com o vínculo antigo', async (contexto) => {
    const ativo = await ciclo(); const planejado = await ciclo({ situacao: 'PLANEJADO' }); const a = await encontro(ativo.id); const b = await encontro(planejado.id);
    const pessoa = await usuario(); await participar(pessoa, ativo); await participar(pessoa, planejado);
    await emAplicacao(async ({ app, agente }) => {
      const { csrf } = await entrar(agente, pessoa); const administrador = supertest.agent(app); const admin = await entrar(administrador, await usuario('ADMIN_CLUBE'));
      const primeira = barreira(); const segunda = barreira(); const atualizarOriginal = conexao.models.Encontro.prototype.update;
      contexto.mock.method(conexao.models.Encontro.prototype, 'update', async function (dados, opcoes) { if (this.id === a.id) await primeira.parar(); if (this.id === b.id) await segunda.parar(); return atualizarOriginal.call(this, dados, opcoes); });
      const reagendamento = editar(administrador, admin.csrf, a.id, { inicioEm: '2026-11-03T17:00:00-03:00' });
      try {
        await aguardar(primeira.pronta); const inscricao = inscrever(agente, csrf, a.id); primeira.liberar();
        const respostas = await Promise.all([reagendamento, inscricao]); assert.equal(respostas[0].status, 200); assert.equal(respostas[1].status, 201); assert.equal(respostas[1].body.data.encontro.inicioEm, '2026-11-03T20:00:00.000Z');
      } finally { primeira.liberar(); }
      const troca = editar(administrador, admin.csrf, b.id, { cicloId: ativo.id });
      try {
        await aguardar(segunda.pronta);
        let notificar; const observada = new Promise((resolver) => { notificar = resolver; }); const buscarOriginal = conexao.models.Encontro.findByPk;
        contexto.mock.method(conexao.models.Encontro, 'findByPk', async function (id, opcoes) { const resultado = await buscarOriginal.call(this, id, opcoes); if (id === b.id && !opcoes.lock && resultado?.cicloId === planejado.id) notificar(); return resultado; });
        const tentativa = inscrever(agente, csrf, b.id); await aguardar(observada); segunda.liberar();
        const respostas = await Promise.all([troca, tentativa]); assert.equal(respostas[0].status, 200); assert.equal(respostas[1].status, 409);
        assert.equal(await conexao.models.InscricaoEncontro.count({ where: { encontroId: b.id } }), 0);
        assert.equal((await inscrever(agente, csrf, b.id)).status, 201);
      } finally { segunda.liberar(); }
    });
  });

  it('exclusão administrativa e inscrição concorrente usam CASCADE sem órfãos nas duas ordens', async (contexto) => {
    const origem = await ciclo(); const a = await encontro(origem.id); const b = await encontro(origem.id); const pessoa = await usuario(); const participacao = await participar(pessoa, origem);
    await emAplicacao(async ({ app, agente }) => {
      const { csrf } = await entrar(agente, pessoa); const administrador = supertest.agent(app); const admin = await entrar(administrador, await usuario('ADMIN_CLUBE'));
      const primeira = barreira(); const criarOriginal = conexao.models.InscricaoEncontro.create;
      contexto.mock.method(conexao.models.InscricaoEncontro, 'create', async function (dados, opcoes) { if (dados.encontroId === a.id) await primeira.parar(); return criarOriginal.call(this, dados, opcoes); });
      const inscricao = inscrever(agente, csrf, a.id);
      try {
        await aguardar(primeira.pronta); const remocao = excluir(administrador, admin.csrf, a.id); primeira.liberar();
        const respostas = await Promise.all([inscricao, remocao]); assert.equal(respostas[0].status, 201); assert.equal(respostas[1].status, 204);
        assert.equal(await conexao.models.InscricaoEncontro.count({ where: { encontroId: a.id } }), 0);
      } finally { primeira.liberar(); }
      const segunda = barreira(); const excluirOriginal = conexao.models.Encontro.prototype.destroy;
      contexto.mock.method(conexao.models.Encontro.prototype, 'destroy', async function (opcoes) { if (this.id === b.id) await segunda.parar(); return excluirOriginal.call(this, opcoes); });
      const remocao = excluir(administrador, admin.csrf, b.id);
      try {
        await aguardar(segunda.pronta); const tentativa = inscrever(agente, csrf, b.id); segunda.liberar();
        const respostas = await Promise.all([remocao, tentativa]); assert.equal(respostas[0].status, 204); assert.equal(respostas[1].status, 404);
        assert.equal(await conexao.models.InscricaoEncontro.count({ where: { encontroId: b.id } }), 0);
        assert.equal((await participacao.reload()).cicloId, origem.id); assert.ok(await pessoa.reload()); assert.ok(await origem.reload());
      } finally { segunda.liberar(); }
    });
  });

  it('o app público monta as quatro rotas no usuário e encontro da sessão', async () => {
    const inicio = new Date(Date.now() + 60 * 60 * 1000).toISOString(); const hoje = dataEmSaoPaulo(); const fim = dataEmSaoPaulo(inicio);
    const origem = await ciclo({ dataInicio: hoje, dataFim: fim }); const evento = await encontro(origem.id, { inicioEm: inicio }); const pessoa = await usuario(); await participar(pessoa, origem); const gestor = await usuario('ADMIN_CLUBE');
    const anteriores = Object.fromEntries(['SESSION_SECRET', 'SESSION_COOKIE_SECURE', 'ALLOWED_ORIGIN'].map((chave) => [chave, process.env[chave]]));
    process.env.SESSION_SECRET = configuracao.segredo; process.env.SESSION_COOKIE_SECURE = 'false'; process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
    try {
      const app = require('../../app'); const agente = supertest.agent(app); const { csrf } = await entrar(agente, pessoa);
      assert.equal((await inscrever(agente, csrf, evento.id)).status, 201); assert.equal(registrar(await agente.get('/api/me/inscricoes').query({ futuros: true })).body.meta.total, 1);
      const administrador = supertest.agent(app); await entrar(administrador, gestor); assert.equal(registrar(await administrador.get(`/api/encontros/${evento.id}/inscritos`)).status, 200);
      assert.equal((await cancelar(agente, csrf, evento.id)).status, 204);
    } finally {
      await require('../../autenticacao/servico').encerrarAutenticacao(); await require('../../database/conexao').encerrarConexao();
      for (const [chave, valor] of Object.entries(anteriores)) { if (valor === undefined) delete process.env[chave]; else process.env[chave] = valor; }
      validarDestinoTeste(conexao); await conexao.models.CicloLeitura.update({ situacao: 'CONCLUIDO' }, { where: { id: origem.id } });
    }
  });
});
