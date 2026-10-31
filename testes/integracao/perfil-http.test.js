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
const { criarRotasPerfil } = require('../../perfil/rotas');
const { configurarHttp } = require('../../intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('../../intermediarios/erros');

const destino = validarBancoTeste(process.env);
const configuracao = carregarConfiguracaoSessao({
  NODE_ENV: 'test', SESSION_SECRET: 'Segredo exclusivo das fixtures de perfil e senhas Leia+', SESSION_COOKIE_SECURE: 'false',
});
const senha = '  Chave antiga 🐝 da fixture  ';
const novaSenha = '  Chave nova 🐝 da fixture  ';
const prefixo = `perfil-http-${process.pid}-${Date.now()}`;

describe('Perfil e troca de senha com cookies e PostgreSQL reais', { timeout: 60_000 }, () => {
  let conexao;
  let hash;
  let sequencia = 0;
  const usuarios = new Set();
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
      validarDestinoTeste(conexao);
      await conexao.models.Usuario.destroy({ where: { id: [...usuarios] } });
    } finally { await conexao.close(); }
  });

  async function criarUsuario(dados = {}) {
    sequencia += 1;
    const usuario = await conexao.models.Usuario.create({
      nome: 'Leitora da fixture', email: `${prefixo}-${sequencia}@escola.example`,
      senhaHash: hash, perfil: 'LEITOR', situacao: 'ATIVO', sessionVersion: 0, ...dados,
    });
    usuarios.add(usuario.id);
    return usuario;
  }

  function sid(cookie) {
    const valor = decodeURIComponent(cookie.split(';')[0].slice('leia.sid='.length));
    return valor.startsWith('s:') ? valor.slice(2, valor.lastIndexOf('.')) : undefined;
  }

  function registrar(resposta, proibidos = []) {
    for (const cookie of resposta.headers['set-cookie'] || []) {
      if (cookie.startsWith('leia.sid=') && sid(cookie)) sids.add(sid(cookie));
    }
    const texto = JSON.stringify(resposta.body);
    assert.doesNotMatch(texto, /senhaHash|senha_hash|sessionVersion|session_version|"sql"|"stack"/);
    for (const valor of [senha, novaSenha, hash, ...proibidos]) assert.ok(!texto.includes(valor));
    return resposta;
  }

  async function token(agente) {
    const resposta = registrar(await agente.get('/api/auth/csrf'));
    assert.equal(resposta.status, 200);
    return resposta.body.data.csrfToken;
  }

  async function entrar(agente, usuario, segredo = senha) {
    const csrf = await token(agente);
    return registrar(await agente.post('/api/auth/login').set('X-CSRF-Token', csrf)
      .send({ email: usuario.email, senha: segredo }), [segredo]);
  }

  async function sessao(id) {
    const [linhas] = await conexao.query('SELECT sid, sess, expire FROM sessoes WHERE sid = $1', { bind: [id] });
    return linhas[0];
  }

  async function emAplicacao(executar, opcoes = {}) {
    const pool = new Pool({ connectionString: destino.url, max: 3 });
    const autenticacao = criarAutenticacao({
      configuracao, pool: opcoes.pool || pool, obterUsuario: () => conexao.models.Usuario,
    });
    const app = express();
    configurarHttp(app, { origemPermitida: 'http://localhost:5173' });
    app.use('/api/auth', autenticacao.roteador);
    app.use('/api/me', autenticacao.identificar, criarRotasPerfil({ obterUsuario: () => conexao.models.Usuario }));
    app.use(rotaNaoEncontrada);
    app.use(tratarErros);
    try { await executar({ app, agente: supertest.agent(app), pool }); }
    finally { await autenticacao.encerrar(); await pool.end(); }
  }

  async function mudarSenha(agente, csrf, entrada = { senhaAtual: senha, novaSenha }) {
    return registrar(await agente.patch('/api/me/senha').set('X-CSRF-Token', csrf).send(entrada),
      Object.values(entrada).filter((valor) => typeof valor === 'string' && valor.length > 0));
  }

  function cookieLogin(resposta) {
    assert.equal(resposta.status, 200);
    return resposta.headers['set-cookie'].find((cookie) => cookie.startsWith('leia.sid=')).split(';')[0];
  }

  it('PATCH me altera somente o próprio nome e reutiliza auth/me em ambas as sessões', async () => {
    const primeira = await criarUsuario();
    const segunda = await criarUsuario();
    await emAplicacao(async ({ app, agente }) => {
      const outraSessao = supertest.agent(app);
      await entrar(agente, primeira);
      await entrar(outraSessao, primeira);
      const csrf = await token(agente);
      const resposta = registrar(await agente.patch('/api/me').query({ id: segunda.id }).set('X-CSRF-Token', csrf)
        .send({ nome: '  Novo nome da leitora  ' }));
      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body.data, {
        id: primeira.id, nome: 'Novo nome da leitora', email: primeira.email, perfil: 'LEITOR', situacao: 'ATIVO',
      });
      assert.equal((await primeira.reload()).sessionVersion, 0);
      assert.equal((await segunda.reload()).nome, 'Leitora da fixture');
      const me = registrar(await outraSessao.get('/api/auth/me'));
      assert.equal(me.status, 200);
      assert.equal(me.body.data.nome, 'Novo nome da leitora');
      assert.equal(registrar(await agente.get('/api/me')).status, 404);
    });
  });

  it('exige autenticação ativa e CSRF; rejeita extras e PATCH vazio nos dois endpoints', async () => {
    const conta = await criarUsuario();
    await emAplicacao(async ({ agente }) => {
      for (const caminho of ['/api/me', '/api/me/senha']) {
        assert.equal(registrar(await agente.patch(caminho).send({})).status, 401);
      }
      await entrar(agente, conta);
      assert.equal(registrar(await agente.patch('/api/me').send({ nome: 'Nome válido' })).status, 403);
      assert.equal(registrar(await agente.patch('/api/me/senha').send({ senhaAtual: senha, novaSenha })).status, 403);
      const csrf = await token(agente);
      for (const corpo of [{}, { nome: 'a' }, { nome: 'a'.repeat(101) }, { nome: null }, { nome: 'Nome', id: conta.id }, { nome: 'Nome', perfil: 'ADMIN_CLUBE' }]) {
        assert.equal(registrar(await agente.patch('/api/me').set('X-CSRF-Token', csrf).send(corpo)).status, 422);
      }
      for (const corpo of [{}, { senhaAtual: senha }, { novaSenha }, { senhaAtual: senha, novaSenha, sessionVersion: 0 }]) {
        assert.equal((await mudarSenha(agente, csrf, corpo)).status, 422);
      }
      await conta.update({ situacao: 'INATIVO', sessionVersion: 1 });
      assert.equal(registrar(await agente.patch('/api/me').set('X-CSRF-Token', csrf).send({ nome: 'Nome' })).status, 401);
      assert.equal((await mudarSenha(agente, csrf)).status, 401);
      const preservada = await conexao.models.Usuario.scope('credenciais').findByPk(conta.id);
      assert.equal(preservada.senhaHash, hash);
      assert.equal(preservada.nome, 'Leitora da fixture');
    });
  });

  it('senha atual incorreta ou aparada não modifica hash, versão ou qualquer sessão', async () => {
    const conta = await criarUsuario();
    const outraConta = await criarUsuario();
    await emAplicacao(async ({ app, agente }) => {
      const outraSessao = supertest.agent(app);
      const outroUsuario = supertest.agent(app);
      const cookies = [cookieLogin(await entrar(agente, conta)), cookieLogin(await entrar(outraSessao, conta)), cookieLogin(await entrar(outroUsuario, outraConta))];
      const csrf = await token(agente);
      const antes = await Promise.all(cookies.map((cookie) => sessao(sid(cookie))));
      for (const senhaAtual of ['Senha incorreta da fixture', senha.trim()]) {
        const resposta = await mudarSenha(agente, csrf, { senhaAtual, novaSenha });
        assert.equal(resposta.status, 422);
        assert.equal(resposta.body.error.fields[0].field, 'senhaAtual');
        assert.equal(resposta.headers['set-cookie'], undefined);
      }
      const persistida = await conexao.models.Usuario.scope('credenciais').findByPk(conta.id);
      assert.equal(persistida.senhaHash, hash);
      assert.equal(persistida.sessionVersion, 0);
      assert.deepEqual(await Promise.all(cookies.map((cookie) => sessao(sid(cookie)))), antes);
      for (const sessaoDoUsuario of [agente, outraSessao, outroUsuario]) {
        assert.equal(registrar(await sessaoDoUsuario.get('/api/auth/me')).status, 200);
      }
    });
  });

  it('nova senha válida revoga ambas as sessões da conta e preserva outra conta', async () => {
    const conta = await criarUsuario();
    const outraConta = await criarUsuario();
    await emAplicacao(async ({ app, agente }) => {
      const outraSessao = supertest.agent(app);
      const outroUsuario = supertest.agent(app);
      const cookieAtual = cookieLogin(await entrar(agente, conta));
      const cookieOutraSessao = cookieLogin(await entrar(outraSessao, conta));
      const cookieOutroUsuario = cookieLogin(await entrar(outroUsuario, outraConta));
      const estadoOutro = await sessao(sid(cookieOutroUsuario));
      const resposta = await mudarSenha(agente, await token(agente));
      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body, { data: { reauthenticate: true } });
      assert.ok(resposta.headers['set-cookie'].some((cookie) => /^leia\.sid=;.*Expires=Thu, 01 Jan 1970/.test(cookie)));
      assert.equal(await sessao(sid(cookieAtual)), undefined);
      const persistida = await conexao.models.Usuario.scope('credenciais').findByPk(conta.id);
      assert.equal(persistida.sessionVersion, 1);
      assert.equal(await bcrypt.compare(novaSenha, persistida.senhaHash), true);
      assert.equal(await bcrypt.compare(novaSenha.trim(), persistida.senhaHash), false);
      assert.equal(await bcrypt.compare(senha, persistida.senhaHash), false);
      assert.equal((await sessao(sid(cookieOutraSessao))).sess.passport.user.sessionVersion, 0);
      assert.equal(registrar(await agente.get('/api/auth/me')).status, 401);
      assert.equal(registrar(await outraSessao.get('/api/auth/me')).status, 401);
      assert.equal(registrar(await supertest(app).get('/api/auth/me').set('Cookie', cookieAtual)).status, 401);
      assert.equal(registrar(await outroUsuario.get('/api/auth/me')).status, 200);
      assert.deepEqual(await sessao(sid(cookieOutroUsuario)), estadoOutro);
      assert.equal((await entrar(supertest.agent(app), conta, senha)).status, 401);
      assert.equal((await entrar(supertest.agent(app), conta, novaSenha)).status, 200);
      assert.equal((await outraConta.reload()).sessionVersion, 0);
    });
  });

  it('limite de 72 bytes é aplicado às duas senhas e 72 bytes Unicode são aceitos exatamente', async () => {
    const atual = 'é'.repeat(36);
    const conta = await criarUsuario({ senhaHash: await bcrypt.hash(atual, 4) });
    await emAplicacao(async ({ agente }) => {
      await entrar(agente, conta, atual);
      const csrf = await token(agente);
      for (const entrada of [
        { senhaAtual: 'é'.repeat(37), novaSenha }, { senhaAtual: atual, novaSenha: 'é'.repeat(37) },
        { senhaAtual: atual, novaSenha: 'a'.repeat(9) }, { senhaAtual: atual, novaSenha: '🙂'.repeat(9) },
      ]) assert.equal((await mudarSenha(agente, csrf, entrada)).status, 422);
      const antes = await conexao.models.Usuario.scope('credenciais').findByPk(conta.id);
      assert.equal(antes.sessionVersion, 0);
      const aceita = 'ç'.repeat(36);
      const resposta = await mudarSenha(agente, csrf, { senhaAtual: atual, novaSenha: aceita });
      assert.equal(resposta.status, 200);
      const depois = await conexao.models.Usuario.scope('credenciais').findByPk(conta.id);
      assert.equal(depois.sessionVersion, 1);
      assert.equal(await bcrypt.compare(aceita, depois.senhaHash), true);
    });
  });

  it('duas alterações concorrentes não se sobrescrevem: um commit e um conflito', async (contexto) => {
    const conta = await criarUsuario();
    await emAplicacao(async ({ app, agente }) => {
      const outra = supertest.agent(app);
      await entrar(agente, conta);
      await entrar(outra, conta);
      const tokens = await Promise.all([token(agente), token(outra)]);
      const gerarHash = bcrypt.hash;
      let liberar;
      const barreira = new Promise((resolver) => { liberar = resolver; });
      let prontas = 0;
      contexto.mock.method(bcrypt, 'hash', async (...argumentos) => {
        const resultado = await gerarHash(...argumentos);
        prontas += 1;
        if (prontas === 2) liberar();
        await barreira;
        return resultado;
      });
      const propostas = ['Nova chave da primeira sessão', 'Nova chave da segunda sessão'];
      const respostas = await Promise.all([agente, outra].map((cliente, indice) => mudarSenha(cliente, tokens[indice], {
        senhaAtual: senha, novaSenha: propostas[indice],
      })));
      assert.equal(prontas, 2);
      assert.deepEqual(respostas.map((resposta) => resposta.status).sort(), [200, 409]);
      const vencedora = respostas.findIndex((resposta) => resposta.status === 200);
      const persistida = await conexao.models.Usuario.scope('credenciais').findByPk(conta.id);
      assert.equal(persistida.sessionVersion, 1);
      assert.equal(await bcrypt.compare(propostas[vencedora], persistida.senhaHash), true);
      assert.equal(await bcrypt.compare(propostas[1 - vencedora], persistida.senhaHash), false);
      for (const cliente of [agente, outra]) assert.equal(registrar(await cliente.get('/api/auth/me')).status, 401);
    });
  });

  it('falha na remoção física após commit mantém 200, cookie removido e revogação lógica', async (contexto) => {
    const conta = await criarUsuario();
    const outraConta = await criarUsuario();
    const poolReal = new Pool({ connectionString: destino.url, max: 3 });
    let falharSid;
    const reservado = 'Senha-reservada SELECT senha_hash postgresql://usuario:credencial@host/banco';
    const avisos = [];
    contexto.mock.method(console, 'warn', (...argumentos) => avisos.push(argumentos.join(' ')));
    const pool = {
      async query(sql, parametros) {
        if (/^DELETE FROM "sessoes"/.test(sql) && parametros[0] === falharSid) throw new Error(reservado);
        return poolReal.query(sql, parametros);
      },
    };
    try {
      await emAplicacao(async ({ app, agente }) => {
        const outro = supertest.agent(app);
        const cookie = cookieLogin(await entrar(agente, conta));
        await entrar(outro, outraConta);
        falharSid = sid(cookie);
        const resposta = await mudarSenha(agente, await token(agente));
        assert.equal(resposta.status, 200);
        assert.deepEqual(resposta.body, { data: { reauthenticate: true } });
        assert.ok(resposta.headers['set-cookie'].some((valor) => valor.startsWith('leia.sid=;')));
        const persistida = await conexao.models.Usuario.scope('credenciais').findByPk(conta.id);
        assert.equal(persistida.sessionVersion, 1);
        assert.equal(await bcrypt.compare(novaSenha, persistida.senhaHash), true);
        assert.equal((await sessao(falharSid)).sess.passport.user.sessionVersion, 0);
        assert.equal(avisos.length, 1);
        assert.doesNotMatch(avisos.join('\n'), /Senha-reservada|SELECT\s|postgresql:\/\/|credencial@host/);
        // Mesmo enquanto DELETE continua falhando, o cookie antigo não obtém
        // acesso autenticado: a desserialização recusa a versão anterior.
        assert.equal(registrar(await supertest(app).get('/api/auth/me').set('Cookie', cookie)).status, 503);
        falharSid = undefined;
        assert.equal(registrar(await supertest(app).get('/api/auth/me').set('Cookie', cookie)).status, 401);
        assert.equal(registrar(await outro.get('/api/auth/me')).status, 200);
      }, { pool });
    } finally { await poolReal.end(); }
  });

  it('o app público monta os PATCH e mantém GET auth/me como consulta da identidade', async () => {
    const conta = await criarUsuario({ perfil: 'ADMIN_CLUBE' });
    const anteriores = Object.fromEntries(['SESSION_SECRET', 'SESSION_COOKIE_SECURE', 'ALLOWED_ORIGIN'].map((chave) => [chave, process.env[chave]]));
    process.env.SESSION_SECRET = configuracao.segredo;
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
    try {
      const app = require('../../app');
      const agente = supertest.agent(app);
      await entrar(agente, conta);
      const csrf = await token(agente);
      assert.equal(registrar(await agente.patch('/api/me').set('X-CSRF-Token', csrf).send({ nome: 'Administradora renomeada' })).status, 200);
      assert.equal(registrar(await agente.get('/api/auth/me')).body.data.nome, 'Administradora renomeada');
      assert.equal((await mudarSenha(agente, csrf)).status, 200);
      assert.equal(registrar(await agente.get('/api/auth/me')).status, 401);
    } finally {
      await require('../../autenticacao/servico').encerrarAutenticacao();
      await require('../../database/conexao').encerrarConexao();
      for (const [chave, valor] of Object.entries(anteriores)) {
        if (valor === undefined) delete process.env[chave];
        else process.env[chave] = valor;
      }
    }
  });
});
