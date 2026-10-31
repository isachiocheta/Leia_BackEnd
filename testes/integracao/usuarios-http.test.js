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
const { criarRotasUsuarios } = require('../../usuarios/rotas');
const { configurarHttp } = require('../../intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('../../intermediarios/erros');

const destino = validarBancoTeste(process.env);
const configuracao = carregarConfiguracaoSessao({
  NODE_ENV: 'test', SESSION_SECRET: 'Segredo exclusivo das fixtures de cadastro e aprovação Leia+',
  SESSION_COOKIE_SECURE: 'false',
});
const senha = '  Senha da leitora 🐝  ';
const prefixo = `usuarios-http-${process.pid}-${Date.now()}`;

describe('Cadastro e administração de leitores no PostgreSQL isolado', { timeout: 60_000 }, () => {
  let conexao;
  let hash;
  let sequencia = 0;
  const ids = {
    Usuario: new Set(), Genero: new Set(), Livro: new Set(), CicloLeitura: new Set(),
    Encontro: new Set(), ParticipacaoLeitura: new Set(), InscricaoEncontro: new Set(),
  };
  const sids = new Set();

  before(async () => {
    conexao = criarConexao();
    validarDestinoTeste(conexao);
    await conexao.authenticate();
    hash = await bcrypt.hash(senha, 4);
  });

  after(async () => {
    if (!conexao) return;
    try {
      validarDestinoTeste(conexao);
      await conexao.query('DELETE FROM sessoes WHERE sid = ANY($1::varchar[])', { bind: [[...sids]] });
      for (const modelo of ['InscricaoEncontro', 'ParticipacaoLeitura', 'Encontro', 'CicloLeitura', 'Livro', 'Genero', 'Usuario']) {
        validarDestinoTeste(conexao);
        if (ids[modelo].size) await conexao.models[modelo].destroy({ where: { id: [...ids[modelo]] } });
      }
    } finally {
      await conexao.close();
    }
  });

  function email() { sequencia += 1; return `${prefixo}-${sequencia}@escola.example`; }

  async function criar(modelo, dados) {
    const registro = await conexao.models[modelo].create(dados);
    ids[modelo].add(registro.id);
    return registro;
  }

  function usuario(dados = {}) {
    return criar('Usuario', {
      nome: 'Leitora da fixture', email: email(), senhaHash: hash,
      perfil: 'LEITOR', situacao: 'ATIVO', sessionVersion: 0, ...dados,
    });
  }

  function registrar(resposta) {
    for (const cookie of resposta.headers['set-cookie'] || []) {
      const valor = decodeURIComponent(cookie.split(';')[0].slice('leia.sid='.length));
      if (cookie.startsWith('leia.sid=') && valor.startsWith('s:')) sids.add(valor.slice(2, valor.lastIndexOf('.')));
    }
    assert.doesNotMatch(JSON.stringify(resposta.body), /senhaHash|senha_hash|sessionVersion|session_version|"sql"|"stack"/);
    assert.ok(!JSON.stringify(resposta.body).includes(senha));
    assert.ok(!JSON.stringify(resposta.body).includes(hash));
    return resposta;
  }

  async function token(agente) {
    const resposta = registrar(await agente.get('/api/auth/csrf'));
    assert.equal(resposta.status, 200);
    return resposta.body.data.csrfToken;
  }

  async function entrar(agente, conta, segredo = senha) {
    const csrf = await token(agente);
    const resposta = registrar(await agente.post('/api/auth/login').set('X-CSRF-Token', csrf)
      .send({ email: conta.email, senha: segredo }));
    return resposta;
  }

  async function cadastrar(agente, dados, csrf) {
    const resposta = registrar(await agente.post('/api/auth/cadastro').set('X-CSRF-Token', csrf).send(dados));
    if (resposta.status === 201) ids.Usuario.add(resposta.body.data.id);
    return resposta;
  }

  async function admin(agente) {
    const conta = await usuario({ perfil: 'ADMIN_CLUBE' });
    assert.equal((await entrar(agente, conta)).status, 200);
    return { conta, csrf: await token(agente) };
  }

  async function mudar(agente, id, situacao, csrf) {
    return registrar(await agente.patch(`/api/usuarios/${id}/situacao`).set('X-CSRF-Token', csrf).send({ situacao }));
  }

  async function emAplicacao(executar, opcoes = {}) {
    const pool = new Pool({ connectionString: destino.url, max: 3 });
    const autenticacao = criarAutenticacao({
      configuracao, pool, obterUsuario: () => conexao.models.Usuario,
      limiteCadastro: { maximo: 100 }, ...opcoes,
    });
    const app = express();
    configurarHttp(app, { origemPermitida: 'http://localhost:5173' });
    app.use('/api/auth', autenticacao.roteador);
    app.use('/api/usuarios', autenticacao.identificar, criarRotasUsuarios({ obterUsuario: () => conexao.models.Usuario }));
    app.use(rotaNaoEncontrada);
    app.use(tratarErros);
    try { await executar({ app, agente: supertest.agent(app) }); }
    finally { await autenticacao.encerrar(); await pool.end(); }
  }

  it('cria LEITOR/PENDENTE normalizado, hash verificável, versão zero e nenhuma autenticação automática', async () => {
    await emAplicacao(async ({ agente }) => {
      const csrf = await token(agente);
      const endereco = email();
      const resposta = await cadastrar(agente, { nome: '  Nova Leitora  ', email: ` ${endereco.toUpperCase()} `, senha }, csrf);
      assert.equal(resposta.status, 201);
      assert.deepEqual(resposta.body.data, {
        id: resposta.body.data.id, nome: 'Nova Leitora', email: endereco, perfil: 'LEITOR', situacao: 'PENDENTE',
      });
      const persistida = await conexao.models.Usuario.scope('credenciais').findByPk(resposta.body.data.id);
      assert.equal(persistida.sessionVersion, 0);
      assert.notEqual(persistida.senhaHash, senha);
      assert.equal(await bcrypt.compare(senha, persistida.senhaHash), true);
      assert.equal(await bcrypt.compare(senha.trim(), persistida.senhaHash), false);
      assert.equal(registrar(await agente.get('/api/auth/me')).status, 401);
      assert.equal((await entrar(agente, persistida)).status, 401);
    });
  });

  it('rejeita injeção de privilégios e todos os campos extras sem criar contas', async () => {
    await emAplicacao(async ({ agente }) => {
      const csrf = await token(agente);
      for (const [campo, valor] of Object.entries({ perfil: 'ADMIN_CLUBE', situacao: 'ATIVO', sessionVersion: 99, senhaHash: hash, id: 1, outro: true })) {
        const endereco = email();
        const resposta = await cadastrar(agente, { nome: 'Leitora', email: endereco, senha, [campo]: valor }, csrf);
        assert.equal(resposta.status, 422);
        assert.equal(await conexao.models.Usuario.count({ where: { email: endereco } }), 0);
      }
    });
  });

  it('valida nome, email e política de senha sem ecoar valores em erros', async () => {
    await emAplicacao(async ({ agente }) => {
      const csrf = await token(agente);
      const valida = { nome: 'Leitora', email: email(), senha };
      for (const invalida of [
        { nome: ' ' }, { nome: 'a' }, { nome: 'a'.repeat(101) }, { nome: null },
        { email: 'email-invalido' }, { email: ['leitora@escola.example'] },
        { senha: 'a'.repeat(9) }, { senha: 'a'.repeat(73) }, { senha: 'é'.repeat(37) },
        { senha: '🙂'.repeat(9) }, { senha: null },
      ]) {
        const resposta = await cadastrar(agente, { ...valida, ...invalida }, csrf);
        assert.equal(resposta.status, 422);
        assert.equal(resposta.body.error.code, 'VALIDATION_ERROR');
        assert.equal(resposta.body.error.fields.some((campo) => Object.hasOwn(campo, 'value')), false);
      }
      for (const campo of ['nome', 'email', 'senha']) {
        const incompleta = { ...valida };
        delete incompleta[campo];
        assert.equal((await cadastrar(agente, incompleta, csrf)).status, 422);
      }
    });
  });

  it('aplica CSRF e limite próprio ao cadastro, sem consumir o limite de login', async () => {
    await emAplicacao(async ({ agente }) => {
      const conta = await usuario();
      const entrada = { nome: 'Leitora', email: email(), senha };
      assert.equal(registrar(await agente.post('/api/auth/cadastro').send(entrada)).status, 403);
      const csrf = await token(agente);
      assert.equal(registrar(await agente.post('/api/auth/cadastro').set('X-CSRF-Token', 'incorreto').send(entrada)).status, 403);
      assert.equal((await cadastrar(agente, entrada, csrf)).status, 429);
      assert.equal((await entrar(agente, conta)).status, 200);
    }, { limiteCadastro: { maximo: 2 } });
  });

  it('aprova pendente, incrementa versão, permite login e mantém repetição idempotente', async () => {
    const leitora = await usuario({ situacao: 'PENDENTE' });
    await emAplicacao(async ({ app, agente }) => {
      const { csrf } = await admin(agente);
      const resposta = await mudar(agente, leitora.id, 'ATIVO', csrf);
      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.data.perfil, 'LEITOR');
      assert.equal((await leitora.reload()).sessionVersion, 1);
      assert.equal((await mudar(agente, leitora.id, 'ATIVO', csrf)).status, 200);
      assert.equal((await leitora.reload()).sessionVersion, 1);
      assert.equal((await entrar(supertest.agent(app), leitora)).status, 200);
      assert.equal((await mudar(agente, leitora.id, 'PENDENTE', csrf)).status, 409);
      assert.equal((await leitora.reload()).situacao, 'ATIVO');
      assert.equal(leitora.sessionVersion, 1);
    });
  });

  it('lista somente leitores com paginação, filtro válido e ordenação permitida', async () => {
    for (let indice = 0; indice < 14; indice += 1) await usuario({ situacao: 'INATIVO' });
    await emAplicacao(async ({ agente }) => {
      const { conta } = await admin(agente);
      const primeira = registrar(await agente.get('/api/usuarios').query({ situacao: 'INATIVO' }));
      assert.equal(primeira.status, 200);
      assert.deepEqual(Object.keys(primeira.body), ['data', 'meta']);
      assert.equal(primeira.body.data.length, 12);
      assert.equal(primeira.body.meta.page, 1);
      assert.equal(primeira.body.meta.pageSize, 12);
      assert.ok(primeira.body.meta.total >= 14);
      assert.ok(primeira.body.data.every((conta) => conta.perfil === 'LEITOR' && conta.situacao === 'INATIVO'));
      assert.ok(primeira.body.data.every((linha, indice, linhas) => indice === 0 || linhas[indice - 1].id < linha.id));
      const segunda = registrar(await agente.get('/api/usuarios').query({ situacao: 'INATIVO', page: '2', pageSize: '12', sort: 'id', direction: 'desc' }));
      assert.equal(segunda.status, 200);
      assert.ok(segunda.body.data.length >= 2);
      assert.equal(segunda.body.meta.page, 2);
      const todas = registrar(await agente.get('/api/usuarios').query({ pageSize: '50' }));
      assert.equal(todas.status, 200);
      assert.ok(todas.body.data.every((linha) => linha.id !== conta.id && linha.perfil === 'LEITOR'));
      for (const consulta of [
        { pageSize: '51' }, { situacao: 'INVALIDA' }, { situacao: ['ATIVO', 'PENDENTE'] },
        { perfil: 'ADMIN_CLUBE' }, { sort: 'senha_hash' }, { direction: 'desc; SELECT 1' },
      ]) assert.equal(registrar(await agente.get('/api/usuarios').query(consulta)).status, 422);
    });
  });

  it('nega administração a anônimo, leitor e administrador indisponível; exige CSRF antes de mudar', async () => {
    const leitora = await usuario();
    await emAplicacao(async ({ app, agente }) => {
      assert.equal(registrar(await agente.get('/api/usuarios')).status, 401);
      assert.equal(registrar(await agente.patch(`/api/usuarios/${leitora.id}/situacao`).send({ situacao: 'INATIVO' })).status, 401);
      assert.equal((await entrar(agente, leitora)).status, 200);
      assert.equal(registrar(await agente.get('/api/usuarios')).status, 403);
      assert.equal(registrar(await agente.patch(`/api/usuarios/${leitora.id}/situacao`).send({ situacao: 'INATIVO' })).status, 403);
      const administrador = supertest.agent(app);
      const { conta, csrf } = await admin(administrador);
      assert.equal(registrar(await administrador.patch(`/api/usuarios/${leitora.id}/situacao`).send({ situacao: 'INATIVO' })).status, 403);
      await conta.update({ situacao: 'INATIVO' });
      assert.equal(registrar(await administrador.get('/api/usuarios')).status, 401);
      assert.equal((await mudar(administrador, leitora.id, 'INATIVO', csrf)).status, 401);
      assert.equal((await leitora.reload()).situacao, 'ATIVO');
    });
  });

  it('não altera administradores, perfil ou campos protegidos e valida ID e PATCH', async () => {
    const leitora = await usuario();
    await emAplicacao(async ({ agente }) => {
      const { conta, csrf } = await admin(agente);
      assert.equal((await mudar(agente, conta.id, 'INATIVO', csrf)).status, 404);
      assert.equal((await conta.reload()).perfil, 'ADMIN_CLUBE');
      assert.equal(conta.situacao, 'ATIVO');
      assert.equal(conta.sessionVersion, 0);
      assert.equal((await mudar(agente, 2147483647, 'ATIVO', csrf)).status, 404);
      for (const [id, corpo] of [
        ['abc', { situacao: 'ATIVO' }], ['0', { situacao: 'ATIVO' }],
        [leitora.id, {}], [leitora.id, { situacao: 'INVALIDA' }],
        [leitora.id, { situacao: 'INATIVO', perfil: 'ADMIN_CLUBE' }],
        [leitora.id, { situacao: 'INATIVO', sessionVersion: 0 }],
      ]) {
        const resposta = registrar(await agente.patch(`/api/usuarios/${id}/situacao`).set('X-CSRF-Token', csrf).send(corpo));
        assert.equal(resposta.status, 422);
      }
      assert.equal((await leitora.reload()).situacao, 'ATIVO');
      assert.equal(leitora.sessionVersion, 0);
    });
  });

  it('desativação e reativação preservam histórico e nunca restauram um cookie antigo ainda não usado', async () => {
    const leitora = await usuario();
    const genero = await criar('Genero', { nome: `Histórico-${process.pid}-${Date.now()}` });
    const livro = await criar('Livro', { titulo: 'Obra da fixture', autor: 'Autora', generoId: genero.id, totalPaginas: 100 });
    const ciclo = await criar('CicloLeitura', { nome: 'Ciclo da fixture', livroId: livro.id, dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    const encontro = await criar('Encontro', { cicloId: ciclo.id, titulo: 'Conversa', inicioEm: '2026-10-20T15:00:00-03:00', local: 'Biblioteca' });
    const participacao = await criar('ParticipacaoLeitura', { usuarioId: leitora.id, cicloId: ciclo.id, paginaAtual: 25 });
    const inscricao = await criar('InscricaoEncontro', { usuarioId: leitora.id, encontroId: encontro.id });
    await emAplicacao(async ({ app, agente }) => {
      const { csrf } = await admin(agente);
      const leitor = supertest.agent(app);
      const login = await entrar(leitor, leitora);
      assert.equal(login.status, 200);
      const cookieAntigo = login.headers['set-cookie'].find((valor) => valor.startsWith('leia.sid=')).split(';')[0];
      assert.equal((await mudar(agente, leitora.id, 'INATIVO', csrf)).status, 200);
      assert.equal((await leitora.reload()).sessionVersion, 1);
      assert.equal((await entrar(supertest.agent(app), leitora)).status, 401);
      assert.equal((await mudar(agente, leitora.id, 'ATIVO', csrf)).status, 200);
      assert.equal((await leitora.reload()).sessionVersion, 2);
      assert.equal(registrar(await supertest(app).get('/api/auth/me').set('Cookie', cookieAntigo)).status, 401);
      assert.equal((await entrar(supertest.agent(app), leitora)).status, 200);
      assert.equal((await participacao.reload()).paginaAtual, 25);
      assert.equal(participacao.usuarioId, leitora.id);
      assert.equal((await inscricao.reload()).usuarioId, leitora.id);
      assert.equal((await ciclo.reload()).id, ciclo.id);
      assert.equal((await encontro.reload()).id, encontro.id);
    });
  });

  it('cadastros concorrentes do mesmo email têm exatamente um sucesso e um conflito 409', async () => {
    await emAplicacao(async ({ app }) => {
      const agentes = [supertest.agent(app), supertest.agent(app)];
      const tokens = await Promise.all(agentes.map(token));
      const endereco = email();
      const respostas = await Promise.all(agentes.map((agente, indice) => cadastrar(agente, {
        nome: 'Leitora concorrente', email: indice === 0 ? endereco : ` ${endereco.toUpperCase()} `, senha,
      }, tokens[indice])));
      assert.deepEqual(respostas.map((resposta) => resposta.status).sort(), [201, 409]);
      assert.equal(respostas.find((resposta) => resposta.status === 409).body.error.code, 'DUPLICATE_RESOURCE');
      assert.equal(await conexao.models.Usuario.count({ where: { email: endereco } }), 1);
      const conta = await conexao.models.Usuario.scope('credenciais').findOne({ where: { email: endereco } });
      assert.equal(conta.perfil, 'LEITOR');
      assert.equal(conta.situacao, 'PENDENTE');
      assert.equal(await bcrypt.compare(senha, conta.senhaHash), true);
      for (const agente of agentes) assert.equal(registrar(await agente.get('/api/auth/me')).status, 401);
    });
  });

  it('aprovações concorrentes não perdem versão nem a incrementam por repetição', async () => {
    const leitora = await usuario({ situacao: 'PENDENTE' });
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await admin(agente);
      const respostas = await Promise.all(Array.from({ length: 3 }, () => mudar(agente, leitora.id, 'ATIVO', csrf)));
      assert.ok(respostas.every((resposta) => resposta.status === 200));
      await leitora.reload();
      assert.equal(leitora.situacao, 'ATIVO');
      assert.equal(leitora.sessionVersion, 1);
    });
  });

  it('monta cadastro e administração nas rotas públicas reais', async () => {
    const variaveis = ['SESSION_SECRET', 'SESSION_COOKIE_SECURE', 'ALLOWED_ORIGIN'];
    const anteriores = Object.fromEntries(variaveis.map((chave) => [chave, process.env[chave]]));
    process.env.SESSION_SECRET = configuracao.segredo;
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
    const app = require('../../app');
    try {
      const agente = supertest.agent(app);
      const endereco = email();
      const cadastrada = await cadastrar(agente, { nome: 'Leitora pública', email: endereco, senha }, await token(agente));
      assert.equal(cadastrada.status, 201);
      const administrador = supertest.agent(app);
      const { csrf } = await admin(administrador);
      const lista = registrar(await administrador.get('/api/usuarios').query({ situacao: 'PENDENTE' }));
      assert.equal(lista.status, 200);
      assert.ok(lista.body.data.every((conta) => conta.perfil === 'LEITOR'));
      assert.equal((await mudar(administrador, cadastrada.body.data.id, 'ATIVO', csrf)).status, 200);
      assert.equal((await entrar(agente, cadastrada.body.data)).status, 200);
    } finally {
      await require('../../autenticacao/servico').encerrarAutenticacao();
      await require('../../database/conexao').encerrarConexao();
      for (const chave of variaveis) {
        if (anteriores[chave] === undefined) delete process.env[chave];
        else process.env[chave] = anteriores[chave];
      }
    }
  });
});
