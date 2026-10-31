'use strict';

const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const express = require('express');
const { Pool } = require('pg');
const supertest = require('supertest');
const { after, before, describe, it } = require('node:test');
const { criarConexao } = require('../../database/conexao');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { carregarConfiguracaoSessao, PRAZO_SESSAO_MS } = require('../../configuracao/sessao');
const { criarAutenticacao, protegerRota } = require('../../autenticacao/rotas');
const { configurarHttp } = require('../../intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('../../intermediarios/erros');

const configuracaoBanco = validarBancoTeste(process.env);
const configuracaoSessao = carregarConfiguracaoSessao({
  NODE_ENV: 'test',
  SESSION_SECRET: 'Segredo exclusivo das fixtures de autenticação do Leia+',
  SESSION_COOKIE_SECURE: 'false',
});
const senha = '  Acesso 🐝 reservado da fixture  ';
const prefixo = `autenticacao-${process.pid}-${Date.now()}`;

// As sessões precisam de transações confirmadas, pois o store usa outra conexão.
// Somente IDs de usuários e SIDs desta suíte são removidos, após validar destino.
describe('Passport, cookies e sessões reais no PostgreSQL isolado', { timeout: 45_000 }, () => {
  let conexao;
  let hash;
  let sequencia = 0;
  const idsUsuarios = new Set();
  const idsSessoes = new Set();

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
      await conexao.query('DELETE FROM sessoes WHERE sid = ANY($1::varchar[])', { bind: [[...idsSessoes]] });
      validarDestinoTeste(conexao);
      await conexao.query('DELETE FROM usuarios WHERE id = ANY($1::integer[])', { bind: [[...idsUsuarios]] });
    } finally {
      await conexao.close();
    }
  });

  async function criarUsuario(alteracoes = {}) {
    sequencia += 1;
    const usuario = await conexao.models.Usuario.create({
      nome: 'Leitora da integração',
      email: `${prefixo}-${sequencia}@escola.example`,
      senhaHash: hash,
      perfil: 'LEITOR',
      situacao: 'ATIVO',
      sessionVersion: 0,
      ...alteracoes,
    });
    idsUsuarios.add(usuario.id);
    return usuario;
  }

  async function emAplicacao(executar, opcoes = {}) {
    const pool = new Pool({ connectionString: configuracaoBanco.url, max: 2 });
    const autenticacao = criarAutenticacao({
      configuracao: configuracaoSessao,
      pool,
      obterUsuario: () => conexao.models.Usuario,
      ...opcoes,
    });
    const app = express();
    let leiturasCsrf = 0;
    if (opcoes.httpsSimulado) {
      app.use((requisicao, resposta, proximo) => {
        requisicao.socket.encrypted = true;
        proximo();
      });
    }
    configurarHttp(app, { origemPermitida: 'http://localhost:5173' });
    app.use('/api/auth', autenticacao.roteador);
    // Rota controlada exclusiva da fixture; nunca integra o app público.
    app.post('/api/auth/fixture-admin', (requisicao, resposta, proximo) => {
      const obterCabecalho = requisicao.get.bind(requisicao);
      requisicao.get = (nome) => {
        if (nome.toLowerCase() === 'x-csrf-token') leiturasCsrf += 1;
        return obterCabecalho(nome);
      };
      proximo();
    }, ...protegerRota('ADMIN_CLUBE'), (requisicao, resposta) => {
      resposta.status(204).end();
    });
    app.use(rotaNaoEncontrada);
    app.use(tratarErros);
    try {
      await executar({ app, pool, agente: supertest.agent(app), contarLeiturasCsrf: () => leiturasCsrf });
    } finally {
      await autenticacao.encerrar();
      if (!pool.ended) await pool.end();
    }
  }

  function registrarCookies(resposta) {
    for (const cookie of resposta.headers['set-cookie'] ?? []) {
      const par = cookie.split(';')[0];
      if (!par.startsWith('leia.sid=')) continue;
      const valor = decodeURIComponent(par.slice('leia.sid='.length));
      if (!valor.startsWith('s:')) continue;
      idsSessoes.add(valor.slice(2, valor.lastIndexOf('.')));
    }
    return resposta;
  }

  function cookieSessao(resposta) {
    registrarCookies(resposta);
    const cookie = (resposta.headers['set-cookie'] ?? []).find((valor) => valor.startsWith('leia.sid=s%3A'));
    assert.ok(cookie, 'A resposta deve estabelecer um SID assinado.');
    return cookie.split(';')[0];
  }

  function sidDoCookie(cookie) {
    const valor = decodeURIComponent(cookie.slice('leia.sid='.length));
    return valor.slice(2, valor.lastIndexOf('.'));
  }

  async function sessao(sid) {
    const [linhas] = await conexao.query('SELECT sid, sess, expire FROM sessoes WHERE sid = $1', { bind: [sid] });
    return linhas[0];
  }

  function semSegredos(resposta) {
    const texto = JSON.stringify(resposta.body);
    assert.ok(!texto.includes(senha));
    assert.ok(!texto.includes(hash));
    assert.doesNotMatch(texto, /senhaHash|senha_hash|sessionVersion|session_version|"stack"|"sql"|postgresql:\/\//);
  }

  function recusa(resposta, status, codigo) {
    registrarCookies(resposta);
    assert.equal(resposta.status, status);
    assert.deepEqual(Object.keys(resposta.body), ['error']);
    assert.equal(resposta.body.error.code, codigo);
    assert.equal(typeof resposta.body.error.message, 'string');
    semSegredos(resposta);
    return resposta.body;
  }

  async function obterToken(agente) {
    const resposta = registrarCookies(await agente.get('/api/auth/csrf'));
    assert.equal(resposta.status, 200);
    assert.deepEqual(Object.keys(resposta.body), ['data']);
    assert.deepEqual(Object.keys(resposta.body.data), ['csrfToken']);
    assert.equal(typeof resposta.body.data.csrfToken, 'string');
    assert.ok(resposta.body.data.csrfToken.length >= 32);
    semSegredos(resposta);
    return { token: resposta.body.data.csrfToken, resposta };
  }

  async function entrar(agente, usuario, segredo = senha) {
    const { token, resposta: anonima } = await obterToken(agente);
    const resposta = registrarCookies(await agente.post('/api/auth/login')
      .set('X-CSRF-Token', token)
      .send({ email: `  ${usuario.email.toUpperCase()}  `, senha: segredo }));
    assert.equal(resposta.status, 200);
    semSegredos(resposta);
    return { resposta, anonima, tokenAnterior: token };
  }

  it('me e logout exigem autenticação antes da verificação de CSRF', async () => {
    await emAplicacao(async ({ agente }) => {
      recusa(await agente.get('/api/auth/me'), 401, 'UNAUTHORIZED');
      recusa(await agente.post('/api/auth/logout'), 401, 'UNAUTHORIZED');
    });
  });

  it('em rota protegida, autenticação e perfil precedem a validação de CSRF', async () => {
    const usuario = await criarUsuario();
    await emAplicacao(async ({ agente, contarLeiturasCsrf }) => {
      recusa(await agente.post('/api/auth/fixture-admin'), 401, 'UNAUTHORIZED');
      assert.equal(contarLeiturasCsrf(), 0);
      await entrar(agente, usuario);
      recusa(await agente.post('/api/auth/fixture-admin'), 403, 'FORBIDDEN');
      assert.equal(contarLeiturasCsrf(), 0);
      await usuario.update({ perfil: 'ADMIN_CLUBE' });
      recusa(await agente.post('/api/auth/fixture-admin'), 403, 'FORBIDDEN');
      assert.equal(contarLeiturasCsrf(), 1);
      const { token } = await obterToken(agente);
      const resposta = await agente.post('/api/auth/fixture-admin').set('X-CSRF-Token', token);
      assert.equal(resposta.status, 204);
      assert.equal(resposta.text, '');
      assert.equal(contarLeiturasCsrf(), 2);
    });
  });

  it('csrf cria sessão anônima persistida e cookie HttpOnly SameSite=Lax no HTTP local', async () => {
    await emAplicacao(async ({ agente }) => {
      const { resposta } = await obterToken(agente);
      const cookie = cookieSessao(resposta);
      const cabecalho = resposta.headers['set-cookie'].find((valor) => valor.startsWith('leia.sid='));
      assert.match(cabecalho, /; HttpOnly(?:;|$)/);
      assert.match(cabecalho, /; SameSite=Lax(?:;|$)/);
      assert.doesNotMatch(cabecalho, /; Secure(?:;|$)/);
      assert.match(cabecalho, /; Path=\/(?:;|$)/);
      assert.match(cabecalho, /; Expires=/);
      const persistida = await sessao(sidDoCookie(cookie));
      assert.ok(persistida);
      assert.equal(persistida.sess.passport?.user, undefined);
      assert.ok(persistida.sess.expiraEm > Date.now());
      assert.ok(persistida.sess.expiraEm <= Date.now() + PRAZO_SESSAO_MS);
      recusa(await agente.get('/api/auth/me'), 401, 'UNAUTHORIZED');
    });
  });

  it('HTTPS entrega o cookie Secure, HttpOnly e SameSite=Lax', async () => {
    await emAplicacao(async ({ agente }) => {
      const { resposta } = await obterToken(agente);
      cookieSessao(resposta);
      const cabecalho = resposta.headers['set-cookie'].find((valor) => valor.startsWith('leia.sid='));
      assert.match(cabecalho, /; Secure(?:;|$)/);
      assert.match(cabecalho, /; HttpOnly(?:;|$)/);
      assert.match(cabecalho, /; SameSite=Lax(?:;|$)/);
    }, {
      httpsSimulado: true,
      configuracao: carregarConfiguracaoSessao({
        NODE_ENV: 'test',
        SESSION_SECRET: 'Segredo exclusivo das fixtures de autenticação do Leia+',
        SESSION_COOKIE_SECURE: 'true',
      }),
    });
  });

  it('login exige token vinculado à mesma sessão, inclusive antes de autenticar', async () => {
    const usuario = await criarUsuario();
    await emAplicacao(async ({ app, agente }) => {
      recusa(await agente.post('/api/auth/login').send({ email: usuario.email, senha }), 403, 'FORBIDDEN');
      const { token } = await obterToken(agente);
      recusa(await agente.post('/api/auth/login').set('X-CSRF-Token', 'token-invalido')
        .send({ email: usuario.email, senha }), 403, 'FORBIDDEN');
      recusa(await agente.post('/api/auth/login').query({ csrfToken: token })
        .send({ email: usuario.email, senha }), 403, 'FORBIDDEN');
      recusa(await agente.post('/api/auth/login')
        .send({ email: usuario.email, senha, csrfToken: token }), 403, 'FORBIDDEN');
      recusa(await agente.post('/api/auth/login').set('X-CSRF-Token', token)
        .query({ email: usuario.email, senha }).send({}), 401, 'UNAUTHORIZED');
      const outro = supertest.agent(app);
      await obterToken(outro);
      recusa(await outro.post('/api/auth/login').set('X-CSRF-Token', token)
        .send({ email: usuario.email, senha }), 403, 'FORBIDDEN');
      recusa(await agente.get('/api/auth/me'), 401, 'UNAUTHORIZED');
    });
  });

  it('rotaciona o SID no Passport, persiste versão zero antes da resposta e não retorna hash', async () => {
    const usuario = await criarUsuario();
    await emAplicacao(async ({ agente }) => {
      const { resposta, anonima } = await entrar(agente, usuario);
      const sidAnterior = sidDoCookie(cookieSessao(anonima));
      const sidAtual = sidDoCookie(cookieSessao(resposta));
      assert.notEqual(sidAtual, sidAnterior);
      assert.equal(await sessao(sidAnterior), undefined);
      assert.deepEqual((await sessao(sidAtual)).sess.passport.user, { id: usuario.id, sessionVersion: 0 });
      const me = await agente.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.deepEqual(me.body, { data: {
        id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: 'LEITOR', situacao: 'ATIVO',
      } });
      semSegredos(me);
    });
  });

  it('uma nova instância recupera a sessão persistida, sem MemoryStore', async () => {
    const usuario = await criarUsuario();
    let cookie;
    await emAplicacao(async ({ agente }) => {
      const { resposta } = await entrar(agente, usuario);
      cookie = cookieSessao(resposta);
    });
    await emAplicacao(async ({ app }) => {
      const resposta = await supertest(app).get('/api/auth/me').set('Cookie', cookie);
      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.data.id, usuario.id);
      semSegredos(resposta);
    });
  });

  it('credenciais erradas, conta inexistente, pendente ou inativa têm recusa 401 equivalente', async () => {
    const ativo = await criarUsuario();
    const pendente = await criarUsuario({ situacao: 'PENDENTE' });
    const inativo = await criarUsuario({ situacao: 'INATIVO' });
    await emAplicacao(async ({ agente }) => {
      const { token } = await obterToken(agente);
      let primeira;
      for (const entrada of [
        { email: ativo.email, senha: 'Segredo incorreto da fixture' },
        { email: `${prefixo}-ausente@escola.example`, senha },
        { email: pendente.email, senha },
        { email: inativo.email, senha },
        { email: ativo.email, senha: senha.trim() },
        { email: ativo.email, senha: 'é'.repeat(37) },
        { email: ativo.email, senha: '' },
        { email: ativo.email, senha: null },
      ]) {
        const corpo = recusa(await agente.post('/api/auth/login').set('X-CSRF-Token', token).send(entrada), 401, 'UNAUTHORIZED');
        if (!primeira) primeira = corpo;
        else assert.deepEqual(corpo, primeira);
      }
      recusa(await agente.get('/api/auth/me'), 401, 'UNAUTHORIZED');
    });
  });

  it('novo token após login é obrigatório; logout destrói sessão e remove cookie sem corpo', async () => {
    const usuario = await criarUsuario();
    await emAplicacao(async ({ agente }) => {
      const { resposta, tokenAnterior } = await entrar(agente, usuario);
      const sid = sidDoCookie(cookieSessao(resposta));
      recusa(await agente.post('/api/auth/logout'), 403, 'FORBIDDEN');
      recusa(await agente.post('/api/auth/logout').set('X-CSRF-Token', tokenAnterior), 403, 'FORBIDDEN');
      const { token } = await obterToken(agente);
      assert.notEqual(token, tokenAnterior);
      const logout = registrarCookies(await agente.post('/api/auth/logout').set('X-CSRF-Token', token));
      assert.equal(logout.status, 204);
      assert.equal(logout.text, '');
      assert.equal(logout.headers['content-type'], undefined);
      assert.equal(logout.headers['content-length'], undefined);
      const removido = logout.headers['set-cookie'].find((valor) => valor.startsWith('leia.sid=;'));
      assert.ok(removido);
      assert.match(removido, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
      assert.equal(await sessao(sid), undefined);
      recusa(await agente.get('/api/auth/me'), 401, 'UNAUTHORIZED');
    });
  });

  it('não confia em versão ausente ou divergente, inclusive quando a versão atual é zero', async () => {
    for (const tipo of ['ausente', 'divergente']) {
      const usuario = await criarUsuario();
      await emAplicacao(async ({ agente }) => {
        const { resposta } = await entrar(agente, usuario);
        const sid = sidDoCookie(cookieSessao(resposta));
        if (tipo === 'ausente') {
          const armazenada = await sessao(sid);
          delete armazenada.sess.passport.user.sessionVersion;
          validarDestinoTeste(conexao);
          await conexao.query('UPDATE sessoes SET sess = $2::json WHERE sid = $1', {
            bind: [sid, JSON.stringify(armazenada.sess)],
          });
        } else {
          await usuario.update({ sessionVersion: 1 });
        }
        recusa(await agente.get('/api/auth/me'), 401, 'UNAUTHORIZED');
      });
    }
  });

  it('consulta perfil e situação atuais e invalida sessões de contas removidas ou desativadas', async () => {
    for (const alteracao of ['INATIVO', 'PENDENTE', 'removido']) {
      const usuario = await criarUsuario();
      await emAplicacao(async ({ agente }) => {
        await entrar(agente, usuario);
        await usuario.update({ perfil: 'ADMIN_CLUBE' });
        const atualizado = await agente.get('/api/auth/me');
        assert.equal(atualizado.status, 200);
        assert.equal(atualizado.body.data.perfil, 'ADMIN_CLUBE');
        semSegredos(atualizado);
        if (alteracao === 'removido') {
          validarDestinoTeste(conexao);
          await usuario.destroy();
        } else {
          await usuario.update({ situacao: alteracao });
        }
        recusa(await agente.get('/api/auth/me'), 401, 'UNAUTHORIZED');
      });
    }
  });

  it('o prazo absoluto de 30 minutos é verificado no servidor e polling não o renova', async () => {
    const usuario = await criarUsuario();
    let tempo = Date.now();
    await emAplicacao(async ({ agente }) => {
      const { resposta } = await entrar(agente, usuario);
      const sid = sidDoCookie(cookieSessao(resposta));
      const inicial = await sessao(sid);
      const expiraEm = inicial.sess.expiraEm;
      assert.equal(expiraEm, tempo + PRAZO_SESSAO_MS);
      for (const acrescimo of [10 * 60_000, 20 * 60_000, PRAZO_SESSAO_MS - 1]) {
        tempo = expiraEm - PRAZO_SESSAO_MS + acrescimo;
        const me = registrarCookies(await agente.get('/api/auth/me'));
        assert.equal(me.status, 200);
        await obterToken(agente);
        const persistida = await sessao(sid);
        assert.equal(persistida.sess.expiraEm, expiraEm);
        assert.equal(new Date(persistida.expire).getTime(), new Date(inicial.expire).getTime());
      }
      tempo = expiraEm;
      recusa(await agente.get('/api/auth/me'), 401, 'UNAUTHORIZED');
      assert.equal(await sessao(sid), undefined);
    }, { agora: () => tempo });
  });

  it('limita tentativas de login e devolve 429 seguro', async () => {
    await emAplicacao(async ({ agente }) => {
      const { token } = await obterToken(agente);
      const entrada = { email: `${prefixo}-limite@escola.example`, senha };
      for (let tentativa = 0; tentativa < 3; tentativa += 1) {
        recusa(await agente.post('/api/auth/login').set('X-CSRF-Token', token).send(entrada), 401, 'UNAUTHORIZED');
      }
      recusa(await agente.post('/api/auth/login').set('X-CSRF-Token', token).send(entrada), 429, 'TOO_MANY_REQUESTS');
    }, { limiteLogin: { maximo: 3, janelaMs: 15 * 60_000 } });
  });

  it('o app público monta csrf, login, me e logout usando o banco de teste validado', async () => {
    const usuario = await criarUsuario();
    const anteriores = {
      SESSION_SECRET: process.env.SESSION_SECRET,
      SESSION_COOKIE_SECURE: process.env.SESSION_COOKIE_SECURE,
      ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN,
    };
    const servico = require('../../autenticacao/servico');
    const banco = require('../../database/conexao');
    try {
      process.env.SESSION_SECRET = 'Segredo temporário exclusivo da fixture do app público';
      process.env.SESSION_COOKIE_SECURE = 'false';
      process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
      const app = require('../../app');
      const agente = supertest.agent(app);
      recusa(await agente.get('/api/auth/me'), 401, 'UNAUTHORIZED');
      const { resposta } = await entrar(agente, usuario);
      const sid = sidDoCookie(cookieSessao(resposta));
      assert.deepEqual((await sessao(sid)).sess.passport.user, { id: usuario.id, sessionVersion: 0 });
      const me = await agente.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.deepEqual(me.body, { data: {
        id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: 'LEITOR', situacao: 'ATIVO',
      } });
      semSegredos(me);
      const { token } = await obterToken(agente);
      const logout = registrarCookies(await agente.post('/api/auth/logout').set('X-CSRF-Token', token));
      assert.equal(logout.status, 204);
      assert.equal(logout.text, '');
      assert.equal(await sessao(sid), undefined);
      recusa(await agente.get('/api/auth/me'), 401, 'UNAUTHORIZED');
      recusa(await agente.post('/api/auth/fixture-admin'), 404, 'NOT_FOUND');
    } finally {
      try {
        await servico.encerrarAutenticacao();
      } finally {
        await banco.encerrarConexao();
        for (const [nome, valor] of Object.entries(anteriores)) {
          if (valor === undefined) delete process.env[nome];
          else process.env[nome] = valor;
        }
      }
    }
  });

  it('falha do store resulta em 503 seguro sem registrar SQL, credenciais ou senha', async (contexto) => {
    const registros = [];
    contexto.mock.method(console, 'error', (...argumentos) => registros.push(argumentos.join(' ')));
    const reservado = 'Senha-fixture-sigilosa SELECT senha_hash postgresql://usuario:credencial@host/banco';
    const pool = { async query() { throw new Error(reservado); } };
    const autenticacao = criarAutenticacao({
      configuracao: configuracaoSessao,
      pool,
      obterUsuario: () => conexao.models.Usuario,
    });
    const app = express();
    configurarHttp(app, { origemPermitida: 'http://localhost:5173' });
    app.use('/api/auth', autenticacao.roteador);
    app.use(rotaNaoEncontrada);
    app.use(tratarErros);
    try {
      const resposta = await supertest.agent(app).get('/api/auth/csrf');
      recusa(resposta, 503, 'SERVICE_UNAVAILABLE');
      assert.ok(!JSON.stringify(resposta.body).includes(reservado));
      await new Promise((resolver) => setImmediate(resolver));
      assert.ok(registros.every((registro) => !registro.includes(reservado)));
      assert.doesNotMatch(registros.join('\n'), /SELECT\s|postgresql:\/\/|Senha-fixture-sigilosa|credencial@host/);
    } finally {
      await autenticacao.encerrar();
    }
  });
});
