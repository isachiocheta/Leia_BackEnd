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
const { criarRotasCiclos } = require('../../ciclos/rotas');
const { bloquearEncontro } = require('../../database/bloqueio-encontro');
const { configurarHttp } = require('../../intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('../../intermediarios/erros');
const { reservarCiclosAtivos } = require('../apoio/coordenacao-ciclos');
const { dataEmSaoPaulo } = require('../../utilitarios/datas-civis');

const destino = validarBancoTeste(process.env);
const configuracao = carregarConfiguracaoSessao({ NODE_ENV: 'test', SESSION_SECRET: 'Segredo exclusivo das fixtures HTTP de encontros Leia+', SESSION_COOKIE_SECURE: 'false' });
const senha = 'Senha das fixtures de encontros';
const prefixo = `encontros-http-${process.pid}-${Date.now()}`;

describe('Encontros HTTP com PostgreSQL e sessões reais', { timeout: 60_000 }, () => {
  let conexao;
  let hash;
  let liberarCiclos;
  let sequencia = 0;
  const ids = Object.fromEntries(['Usuario', 'Genero', 'Livro', 'CicloLeitura', 'Encontro', 'ParticipacaoLeitura', 'InscricaoEncontro'].map((modelo) => [modelo, new Set()]));
  const sids = new Set();
  before(async () => {
    liberarCiclos = await reservarCiclosAtivos();
    conexao = criarConexao(); validarDestinoTeste(conexao); await conexao.authenticate();
    hash = await bcrypt.hash(senha, 4);
  });
  after(async () => {
    try {
      if (conexao) {
        try {
          validarDestinoTeste(conexao);
          await conexao.query('DELETE FROM sessoes WHERE sid = ANY($1::varchar[])', { bind: [[...sids]] });
          for (const modelo of ['InscricaoEncontro', 'ParticipacaoLeitura', 'Encontro', 'CicloLeitura', 'Livro', 'Genero', 'Usuario']) {
            validarDestinoTeste(conexao);
            if (ids[modelo].size) await conexao.models[modelo].destroy({ where: { id: [...ids[modelo]] } });
          }
        } finally { await conexao.close(); }
      }
    } finally { if (liberarCiclos) await liberarCiclos(); }
  });
  async function criar(modelo, dados, transaction) {
    const registro = await conexao.models[modelo].create(dados, { transaction }); ids[modelo].add(registro.id); return registro;
  }
  async function ciclo(dados = {}) {
    sequencia += 1;
    const genero = await criar('Genero', { nome: `${prefixo}-${sequencia}` });
    const livro = await criar('Livro', { titulo: 'Obra dos encontros', autor: 'Autora', generoId: genero.id, totalPaginas: 100 });
    return criar('CicloLeitura', { nome: 'Ciclo dos encontros', livroId: livro.id, dataInicio: '2026-11-01', dataFim: '2026-11-03', ...dados });
  }
  function dados(cicloId, extras = {}) { return { cicloId, titulo: 'Conversa sobre a obra', inicioEm: '2026-11-02T12:00:00-03:00', local: 'Biblioteca', ...extras }; }
  function encontro(cicloId, extras = {}) { return criar('Encontro', dados(cicloId, extras)); }
  function usuario(perfil = 'ADMIN_CLUBE') {
    sequencia += 1;
    return criar('Usuario', { nome: 'Pessoa dos encontros', email: `${prefixo}-${sequencia}@escola.example`, senhaHash: hash, perfil, situacao: 'ATIVO', sessionVersion: 0 });
  }
  function registrar(resposta) {
    for (const cookie of resposta.headers['set-cookie'] || []) {
      const valor = decodeURIComponent(cookie.split(';')[0].slice('leia.sid='.length));
      if (cookie.startsWith('leia.sid=') && valor.startsWith('s:')) sids.add(valor.slice(2, valor.lastIndexOf('.')));
    }
    assert.doesNotMatch(JSON.stringify(resposta.body), /senhaHash|senha_hash|"sql"|"stack"/);
    return resposta;
  }
  async function token(agente) {
    const resposta = registrar(await agente.get('/api/auth/csrf')); assert.equal(resposta.status, 200); return resposta.body.data.csrfToken;
  }
  async function entrar(agente, conta = null) {
    const pessoa = conta || await usuario(); const csrf = await token(agente);
    assert.equal(registrar(await agente.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email: pessoa.email, senha })).status, 200);
    return { conta: pessoa, csrf: await token(agente) };
  }
  async function post(agente, csrf, entrada) {
    const resposta = registrar(await agente.post('/api/encontros').set('X-CSRF-Token', csrf).send(entrada));
    if (resposta.status === 201) ids.Encontro.add(resposta.body.data.id);
    return resposta;
  }
  async function patch(agente, csrf, id, entrada) { return registrar(await agente.patch(`/api/encontros/${id}`).set('X-CSRF-Token', csrf).send(entrada)); }
  async function excluir(agente, csrf, id) { return registrar(await agente.delete(`/api/encontros/${id}`).set('X-CSRF-Token', csrf)); }
  async function mudarCiclo(agente, csrf, id, entrada) { return registrar(await agente.patch(`/api/ciclos/${id}`).set('X-CSRF-Token', csrf).send(entrada)); }
  async function emAplicacao(executar, { agora = () => Date.parse('2026-11-01T12:00:00Z') } = {}) {
    const pool = new Pool({ connectionString: destino.url, max: 3 });
    const autenticacao = criarAutenticacao({ configuracao, pool, obterUsuario: () => conexao.models.Usuario });
    const app = express(); configurarHttp(app, { origemPermitida: 'http://localhost:5173' });
    app.use('/api/auth', autenticacao.roteador);
    app.use('/api/encontros', autenticacao.identificar, criarRotasEncontros({ obterConexao: () => conexao, agora }));
    app.use('/api/ciclos', autenticacao.identificar, criarRotasCiclos({ obterConexao: () => conexao, agora }));
    app.use(rotaNaoEncontrada); app.use(tratarErros);
    try { await executar({ app, agente: supertest.agent(app) }); }
    finally { await autenticacao.encerrar(); await pool.end(); }
  }
  async function aguardar(sinal) {
    let prazo;
    try { await Promise.race([sinal, new Promise((_, rejeitar) => { prazo = setTimeout(() => rejeitar(new Error('A operação não atingiu o ponto de sincronização.')), 3000); })]); }
    finally { clearTimeout(prazo); }
  }
  function barreira() {
    let sinalizar; let liberar;
    const pronta = new Promise((resolver) => { sinalizar = resolver; });
    const liberada = new Promise((resolver) => { liberar = resolver; });
    return { pronta, liberar, async parar() { sinalizar(); await liberada; } };
  }

  it('CRUD começa AGENDADO em ciclo planejado, preserva parciais e informa quantidade de inscritos', async () => {
    const origem = await ciclo();
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      const criada = await post(agente, csrf, dados(origem.id, { descricao: 'Capítulos iniciais' }));
      assert.equal(criada.status, 201); const id = criada.body.data.id;
      assert.equal(criada.body.data.situacao, 'AGENDADO');
      assert.equal(criada.body.data.inicioEm, '2026-11-02T15:00:00.000Z');
      assert.equal(criada.body.data.quantidadeInscritos, 0);
      const leitora = await usuario('LEITOR');
      await criar('InscricaoEncontro', { usuarioId: leitora.id, encontroId: id });
      const detalhe = registrar(await agente.get(`/api/encontros/${id}`));
      assert.equal(detalhe.status, 200); assert.equal(detalhe.body.data.quantidadeInscritos, 1);
      const editada = await patch(agente, csrf, id, { titulo: 'Título revisto', descricao: null });
      assert.equal(editada.status, 200);
      assert.equal(editada.body.data.local, 'Biblioteca');
      assert.equal(editada.body.data.inicioEm, criada.body.data.inicioEm);
      assert.equal(editada.body.data.descricao, null);
      assert.equal(editada.body.data.quantidadeInscritos, 1);
      assert.equal((await conexao.models.Encontro.findByPk(id)).titulo, 'Título revisto');
    });
  });

  it('contas ativas consultam e somente administrador com CSRF escreve', async () => {
    const existente = await encontro((await ciclo()).id);
    await emAplicacao(async ({ app, agente }) => {
      assert.equal(registrar(await agente.get('/api/encontros')).status, 401);
      assert.equal(registrar(await agente.get(`/api/encontros/${existente.id}`)).status, 401);
      const leitor = await usuario('LEITOR'); const { csrf } = await entrar(agente, leitor);
      assert.equal(registrar(await agente.get('/api/encontros')).status, 200);
      assert.equal(registrar(await agente.get(`/api/encontros/${existente.id}`)).status, 200);
      assert.equal((await post(agente, csrf, dados(existente.cicloId))).status, 403);
      assert.equal((await patch(agente, csrf, existente.id, { titulo: 'Outro' })).status, 403);
      assert.equal((await excluir(agente, csrf, existente.id)).status, 403);
      const administrador = supertest.agent(app); await entrar(administrador);
      assert.equal(registrar(await administrador.post('/api/encontros').send(dados(existente.cicloId))).status, 403);
      assert.equal(registrar(await administrador.patch(`/api/encontros/${existente.id}`).send({ titulo: 'Outro' })).status, 403);
      assert.equal(registrar(await administrador.delete(`/api/encontros/${existente.id}`)).status, 403);
      await leitor.update({ situacao: 'INATIVO', sessionVersion: 1 });
      assert.equal(registrar(await agente.get('/api/encontros')).status, 401);
    });
  });

  it('valida campos, ISO com offset e referência e recusa criação em ciclo concluído ou no passado', async () => {
    const origem = await ciclo(); const concluido = await ciclo({ situacao: 'CONCLUIDO' });
    const existente = await encontro(origem.id);
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      for (const alteracao of [
        { titulo: '' }, { titulo: 't'.repeat(121) }, { local: '  ' }, { local: 'l'.repeat(181) },
        { descricao: 'd'.repeat(2001) }, { inicioEm: '2026-11-02T12:00:00' }, { inicioEm: '2026-02-30T12:00:00Z' },
        { inicioEm: '2026-11-01T12:00:00Z' }, { inicioEm: '2026-10-31T15:00:00Z' },
        { cicloId: 2147483647 }, { cicloId: null }, { situacao: 'AGENDADO' }, { id: 1 },
      ]) assert.equal((await post(agente, csrf, dados(origem.id, alteracao))).status, 422);
      for (const campo of ['cicloId', 'titulo', 'inicioEm', 'local']) {
        const incompleta = dados(origem.id); delete incompleta[campo]; assert.equal((await post(agente, csrf, incompleta)).status, 422);
      }
      assert.equal((await post(agente, csrf, dados(concluido.id))).status, 409);
      assert.equal((await patch(agente, csrf, existente.id, {})).status, 422);
      assert.equal((await patch(agente, csrf, existente.id, { inicioEm: null })).status, 422);
      assert.equal((await patch(agente, csrf, existente.id, { cicloId: 2147483647 })).status, 422);
      assert.equal((await patch(agente, csrf, 2147483647, { titulo: 'Ausente' })).status, 404);
      assert.equal((await excluir(agente, csrf, 2147483647)).status, 404);
      assert.equal(registrar(await agente.get('/api/encontros/0')).status, 422);
    });
  });

  it('fuso e último dia aceitam todo o período civil em São Paulo', async () => {
    const origem = await ciclo();
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      assert.equal((await post(agente, csrf, dados(origem.id, { inicioEm: '2026-11-01T02:59:59.999Z' }))).status, 422);
      assert.equal((await post(agente, csrf, dados(origem.id, { inicioEm: '2026-11-01T03:00:00Z' }))).status, 201);
      const final = await post(agente, csrf, dados(origem.id, { inicioEm: '2026-11-04T05:59:59.999+03:00' }));
      assert.equal(final.status, 201); assert.equal(final.body.data.inicioEm, '2026-11-04T02:59:59.999Z');
      assert.equal((await post(agente, csrf, dados(origem.id, { inicioEm: '2026-11-04T03:00:00Z' }))).status, 422);
    }, { agora: () => Date.parse('2026-10-30T12:00:00Z') });
  });

  it('realização só ocorre a partir do início e estados finais só permitem correções de texto', async () => {
    const origem = await ciclo(); const destino = await ciclo();
    const existente = await encontro(origem.id);
    let agora = Date.parse('2026-11-01T12:00:00Z');
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      assert.equal((await patch(agente, csrf, existente.id, { situacao: 'REALIZADO' })).status, 409);
      agora = existente.inicioEm.getTime();
      assert.equal(registrar(await agente.get(`/api/encontros/${existente.id}`)).body.data.situacao, 'AGENDADO');
      assert.equal((await patch(agente, csrf, existente.id, { situacao: 'REALIZADO' })).status, 200);
      for (const alteracao of [{ situacao: 'AGENDADO' }, { situacao: 'CANCELADO' }, { cicloId: destino.id }, { inicioEm: '2026-11-03T15:00:00Z' }]) assert.equal((await patch(agente, csrf, existente.id, alteracao)).status, 409);
      await origem.update({ situacao: 'CONCLUIDO' });
      const corrigida = await patch(agente, csrf, existente.id, { titulo: 'Correção', local: 'Sala 2', descricao: 'Correção histórica' });
      assert.equal(corrigida.status, 200); assert.equal(corrigida.body.data.situacao, 'REALIZADO');
      assert.equal(corrigida.body.data.inicioEm, existente.inicioEm.toISOString());
      const cancelado = await encontro(destino.id);
      assert.equal((await patch(agente, csrf, cancelado.id, { situacao: 'CANCELADO' })).status, 200);
      for (const alteracao of [{ situacao: 'AGENDADO' }, { situacao: 'REALIZADO' }, { cicloId: origem.id }, { inicioEm: '2026-11-03T15:00:00Z' }]) assert.equal((await patch(agente, csrf, cancelado.id, alteracao)).status, 409);
      assert.equal((await patch(agente, csrf, cancelado.id, { titulo: 'Cancelado corrigido' })).status, 200);
    }, { agora: () => agora });
  });

  it('reagendamento exige futuro válido e troca de ciclo requer destino compatível e nenhuma inscrição', async () => {
    const origem = await ciclo(); const destino = await ciclo();
    const fora = await ciclo({ dataInicio: '2026-12-01', dataFim: '2026-12-03' });
    const concluido = await ciclo({ situacao: 'CONCLUIDO' });
    const existente = await encontro(origem.id);
    const inscrito = await usuario('LEITOR');
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      assert.equal((await patch(agente, csrf, existente.id, { inicioEm: '2026-11-01T12:00:00Z' })).status, 422);
      assert.equal((await patch(agente, csrf, existente.id, { inicioEm: '2026-11-04T03:00:00Z' })).status, 422);
      assert.equal((await patch(agente, csrf, existente.id, { cicloId: fora.id })).status, 422);
      assert.equal((await patch(agente, csrf, existente.id, { cicloId: concluido.id })).status, 409);
      assert.equal((await patch(agente, csrf, existente.id, { cicloId: destino.id, inicioEm: '2026-11-03T16:00:00-03:00' })).status, 200);
      await criar('InscricaoEncontro', { usuarioId: inscrito.id, encontroId: existente.id });
      assert.equal((await patch(agente, csrf, existente.id, { cicloId: origem.id, titulo: 'Não gravar' })).status, 409);
      assert.equal((await existente.reload()).cicloId, destino.id); assert.equal(existente.titulo, 'Conversa sobre a obra');
      assert.equal((await patch(agente, csrf, existente.id, { inicioEm: '2026-11-03T20:00:00Z' })).status, 200);
      assert.equal((await patch(agente, csrf, existente.id, { situacao: 'CANCELADO' })).status, 200);
      assert.equal(registrar(await agente.get(`/api/encontros/${existente.id}`)).body.data.quantidadeInscritos, 1);
    });
  });

  it('exclusão física usa CASCADE apenas para inscrições do encontro excluído', async () => {
    const origem = await ciclo(); const a = await encontro(origem.id); const b = await encontro(origem.id);
    const pessoa = await usuario('LEITOR');
    const participacao = await criar('ParticipacaoLeitura', { usuarioId: pessoa.id, cicloId: origem.id, paginaAtual: 20 });
    const inscricaoA = await criar('InscricaoEncontro', { usuarioId: pessoa.id, encontroId: a.id });
    const inscricaoB = await criar('InscricaoEncontro', { usuarioId: pessoa.id, encontroId: b.id });
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente); const resposta = await excluir(agente, csrf, a.id);
      assert.equal(resposta.status, 204); assert.equal(resposta.text, ''); assert.equal(resposta.headers['content-type'], undefined);
      assert.equal(await conexao.models.Encontro.findByPk(a.id), null);
      assert.equal(await conexao.models.InscricaoEncontro.findByPk(inscricaoA.id), null);
      assert.ok(await conexao.models.InscricaoEncontro.findByPk(inscricaoB.id));
      assert.equal((await participacao.reload()).paginaAtual, 20); assert.ok(await origem.reload()); assert.ok(await pessoa.reload());
      assert.equal(registrar(await agente.get(`/api/encontros/${b.id}`)).body.data.quantidadeInscritos, 1);
    });
  });

  it('filtros combinados por título, ciclo e situação têm ordenação e paginação estáveis', async () => {
    const origem = await ciclo(); const outra = await ciclo(); const termo = `${prefixo}-busca`;
    const a = await encontro(origem.id, { titulo: `${termo} B`, inicioEm: '2026-11-03T12:00:00Z' });
    const b = await encontro(origem.id, { titulo: `${termo} A` }); const c = await encontro(origem.id, { titulo: `${termo} A` });
    await encontro(origem.id, { titulo: `${termo} C`, situacao: 'CANCELADO' }); await encontro(outra.id, { titulo: `${termo} A` });
    await emAplicacao(async ({ agente }) => {
      await entrar(agente);
      const consulta = { q: termo.toUpperCase(), cicloId: origem.id, situacao: 'AGENDADO', sort: 'titulo', pageSize: 2 };
      const primeira = registrar(await agente.get('/api/encontros').query(consulta));
      assert.equal(primeira.status, 200); assert.deepEqual(primeira.body.meta, { page: 1, pageSize: 2, total: 3 });
      assert.deepEqual(primeira.body.data.map((registro) => registro.id), [b.id, c.id]);
      const segunda = registrar(await agente.get('/api/encontros').query({ ...consulta, page: 2 })); assert.deepEqual(segunda.body.data.map((registro) => registro.id), [a.id]);
      const inversa = registrar(await agente.get('/api/encontros').query({ ...consulta, sort: 'inicioEm', direction: 'desc', pageSize: 50 }));
      assert.deepEqual(inversa.body.data.map((registro) => registro.id), [a.id, c.id, b.id]);
      for (const invalida of [{ sort: 'id' }, { cicloId: 0 }, { situacao: 'INVALIDA' }, { direction: 'ASC' }, { pageSize: 51 }, { extra: true }]) assert.equal(registrar(await agente.get('/api/encontros').query(invalida)).status, 422);
    });
  });

  it('inscrição concorrente sob o protocolo de locks impede a troca de ciclo depois de confirmar', async (contexto) => {
    const origem = await ciclo(); const destino = await ciclo(); const existente = await encontro(origem.id); const pessoa = await usuario('LEITOR');
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente); const transaction = await conexao.transaction();
      try {
        await bloquearEncontro(conexao, existente.id, transaction);
        await criar('InscricaoEncontro', { usuarioId: pessoa.id, encontroId: existente.id }, transaction);
        const original = conexao.models.Livro.findByPk;
        let notificar;
        const notificada = new Promise((resolver) => { notificar = resolver; });
        contexto.mock.method(conexao.models.Livro, 'findByPk', async function (...argumentos) {
          if (argumentos[1]?.lock && argumentos[1].transaction !== transaction) notificar();
          return original.apply(this, argumentos);
        });
        const tentativa = patch(agente, csrf, existente.id, { cicloId: destino.id });
        // A requisição aguardará os pais já bloqueados pela inscrição.
        await aguardar(notificada); await transaction.commit();
        assert.equal((await tentativa).status, 409); assert.equal((await existente.reload()).cicloId, origem.id);
      } finally { if (!transaction.finished) { validarDestinoTeste(conexao); await transaction.rollback(); } }
    });
  });

  it('concorre com redução de período nas duas ordens sem deixar encontro fora do ciclo', async (contexto) => {
    const origem = await ciclo(); const segundo = await ciclo();
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente); const primeiraBarreira = barreira(); const criarOriginal = conexao.models.Encontro.create;
      contexto.mock.method(conexao.models.Encontro, 'create', async function (entrada, opcoes) {
        if (entrada.cicloId === origem.id) await primeiraBarreira.parar();
        return criarOriginal.call(this, entrada, opcoes);
      });
      const criacao = post(agente, csrf, dados(origem.id, { inicioEm: '2026-11-03T15:00:00Z' }));
      try {
        await aguardar(primeiraBarreira.pronta);
        const reducao = mudarCiclo(agente, csrf, origem.id, { dataFim: '2026-11-02' });
        primeiraBarreira.liberar();
        const respostas = await Promise.all([criacao, reducao]); assert.equal(respostas[0].status, 201); assert.equal(respostas[1].status, 409);
      } finally { primeiraBarreira.liberar(); }
      const segundaBarreira = barreira(); const atualizarOriginal = conexao.models.CicloLeitura.prototype.update;
      contexto.mock.method(conexao.models.CicloLeitura.prototype, 'update', async function (entrada, opcoes) {
        if (this.id === segundo.id) await segundaBarreira.parar();
        return atualizarOriginal.call(this, entrada, opcoes);
      });
      const reducao = mudarCiclo(agente, csrf, segundo.id, { dataFim: '2026-11-02' });
      try {
        await aguardar(segundaBarreira.pronta);
        const criacaoPosterior = post(agente, csrf, dados(segundo.id, { inicioEm: '2026-11-03T15:00:00Z' }));
        segundaBarreira.liberar();
        const respostas = await Promise.all([reducao, criacaoPosterior]); assert.equal(respostas[0].status, 200); assert.equal(respostas[1].status, 422);
      } finally { segundaBarreira.liberar(); }
    });
  });

  it('conclusão e criação concorrentes se revalidam sob os mesmos locks nas duas ordens', async (contexto) => {
    const primeiro = await ciclo({ situacao: 'EM_ANDAMENTO' });
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente); const primeiraBarreira = barreira(); const atualizarOriginal = conexao.models.CicloLeitura.prototype.update;
      contexto.mock.method(conexao.models.CicloLeitura.prototype, 'update', async function (entrada, opcoes) {
        if (this.id === primeiro.id) await primeiraBarreira.parar();
        return atualizarOriginal.call(this, entrada, opcoes);
      });
      const conclusao = mudarCiclo(agente, csrf, primeiro.id, { situacao: 'CONCLUIDO' });
      try {
        await aguardar(primeiraBarreira.pronta);
        const criacao = post(agente, csrf, dados(primeiro.id)); primeiraBarreira.liberar();
        const respostas = await Promise.all([conclusao, criacao]); assert.equal(respostas[0].status, 200); assert.equal(respostas[1].status, 409);
      } finally { primeiraBarreira.liberar(); }
      const segundo = await ciclo({ situacao: 'EM_ANDAMENTO' }); const segundaBarreira = barreira(); const criarOriginal = conexao.models.Encontro.create;
      contexto.mock.method(conexao.models.Encontro, 'create', async function (entrada, opcoes) {
        if (entrada.cicloId === segundo.id) await segundaBarreira.parar();
        return criarOriginal.call(this, entrada, opcoes);
      });
      const criacao = post(agente, csrf, dados(segundo.id));
      try {
        await aguardar(segundaBarreira.pronta);
        const tentativa = mudarCiclo(agente, csrf, segundo.id, { situacao: 'CONCLUIDO' }); segundaBarreira.liberar();
        const respostas = await Promise.all([criacao, tentativa]); assert.equal(respostas[0].status, 201); assert.equal(respostas[1].status, 409);
        assert.equal(respostas[0].body.data.situacao, 'AGENDADO');
        await patch(agente, csrf, respostas[0].body.data.id, { situacao: 'CANCELADO' });
        assert.equal((await mudarCiclo(agente, csrf, segundo.id, { situacao: 'CONCLUIDO' })).status, 200);
      } finally { segundaBarreira.liberar(); }
    });
  });

  it('o app público monta todos os endpoints de encontros', async () => {
    const inicio = new Date(Date.now() + 60 * 60 * 1000).toISOString(); const dia = dataEmSaoPaulo(inicio);
    const origem = await ciclo({ dataInicio: dia, dataFim: dia }); const pessoa = await usuario();
    const anteriores = Object.fromEntries(['SESSION_SECRET', 'SESSION_COOKIE_SECURE', 'ALLOWED_ORIGIN'].map((chave) => [chave, process.env[chave]]));
    process.env.SESSION_SECRET = configuracao.segredo; process.env.SESSION_COOKIE_SECURE = 'false'; process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
    try {
      const agente = supertest.agent(require('../../app')); const { csrf } = await entrar(agente, pessoa);
      const criada = await post(agente, csrf, dados(origem.id, { inicioEm: inicio })); assert.equal(criada.status, 201); const id = criada.body.data.id;
      assert.equal(registrar(await agente.get('/api/encontros')).status, 200); assert.equal(registrar(await agente.get(`/api/encontros/${id}`)).status, 200);
      assert.equal((await patch(agente, csrf, id, { titulo: 'Nome público' })).status, 200); assert.equal((await excluir(agente, csrf, id)).status, 204);
    } finally {
      await require('../../autenticacao/servico').encerrarAutenticacao(); await require('../../database/conexao').encerrarConexao();
      for (const [chave, valor] of Object.entries(anteriores)) { if (valor === undefined) delete process.env[chave]; else process.env[chave] = valor; }
    }
  });
});
