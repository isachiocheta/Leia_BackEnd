'use strict';

const assert = require('node:assert/strict');
const { mock } = require('node:test');
const bcrypt = require('bcrypt');
const supertest = require('supertest');
const { Pool } = require('pg');
const banco = require('../../database/conexao');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { carregarConfiguracaoSessao } = require('../../configuracao/sessao');
const { criarAutenticacao } = require('../../autenticacao/rotas');
const servicoAutenticacao = require('../../autenticacao/servico');
const { dataEmSaoPaulo } = require('../../utilitarios/datas-civis');

const SENHA = 'Senha transversal exclusiva 21!';
const SEGREDO = 'Segredo exclusivo das sessoes transversais Leia+ 21';
const tabelas = ['usuarios', 'generos', 'livros', 'ciclos_leitura', 'encontros', 'participacoes_leitura', 'inscricoes_encontro', 'sessoes'];
const esquema = `leia_transversal_${process.pid}_${Date.now()}`;
const identificador = (nome) => `"${nome.replace(/"/g, '""')}"`;

function conferirResposta(resposta) {
  const corpo = JSON.stringify(resposta.body);
  for (const segredo of [SENHA, SEGREDO, 'SEGREDO_INTERNO_TRANSVERSAL']) assert.ok(!corpo.includes(segredo));
  assert.doesNotMatch(corpo, /"(?:senhaHash|senha_hash|sessionVersion|session_version|sql|stack)"|\$2[aby]\$\d\d\$/);
  if (resposta.status >= 400) {
    assert.deepEqual(Object.keys(resposta.body), ['error']);
    assert.doesNotMatch(corpo, /postgres(?:ql)?:\/\/|SELECT |INSERT INTO |UPDATE "|DELETE FROM /);
  }
  if (resposta.status === 204) { assert.equal(resposta.text, ''); assert.equal(resposta.headers['content-type'], undefined); }
  return resposta;
}

async function criarCenarioTransversal() {
  const destino = validarBancoTeste(process.env);
  const administracao = banco.criarConexao();
  let conexao; let pool; let autenticacao; let app; let hash; let contas; let tempoSessao; let base;
  const substituicoes = [];
  function validar() {
    validarDestinoTeste(administracao);
    assert.match(esquema, /^leia_transversal_\d+_\d+$/);
  }
  const tabela = (nome) => `${identificador(esquema)}.${identificador(nome)}`;
  async function encerrar() {
    for (const substituicao of substituicoes.reverse()) substituicao.mock.restore();
    try {
      if (autenticacao) await autenticacao.encerrar();
      if (pool) await pool.end();
      if (conexao) await conexao.close();
      validar(); await administracao.query(`DROP SCHEMA IF EXISTS ${identificador(esquema)} CASCADE`);
    } finally { await administracao.close(); }
  }
  try {
    validar(); await administracao.authenticate();
    await administracao.query(`CREATE SCHEMA ${identificador(esquema)}`);
    for (const nome of tabelas) {
      await administracao.query(`CREATE TABLE ${tabela(nome)} (LIKE public.${identificador(nome)} INCLUDING ALL)`);
      if (nome !== 'sessoes') {
        // Sequences próprias: nem as fixtures nem os POSTs avançam sequences públicas.
        await administracao.query(`CREATE SEQUENCE ${tabela(`${nome}_id_seq`)} OWNED BY ${tabela(nome)}.id`);
        await administracao.query(`ALTER TABLE ${tabela(nome)} ALTER COLUMN id SET DEFAULT nextval('${tabela(`${nome}_id_seq`)}'::regclass)`);
      }
    }
    // Copia as FKs reais das migrations (LIKE não as copia). pg_catalog no
    // search_path obriga pg_get_constraintdef a qualificar as referências públicas.
    await administracao.transaction(async (transaction) => {
      await administracao.query('SET LOCAL search_path TO pg_catalog', { transaction });
      const [chaves] = await administracao.query(`SELECT t.relname AS tabela, c.conname AS nome, pg_get_constraintdef(c.oid) AS definicao
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND c.contype = 'f' AND t.relname = ANY($tabelas::text[])`, { transaction, bind: { tabelas } });
      assert.equal(chaves.length, 7);
      for (const chave of chaves) {
        assert.ok(tabelas.includes(chave.tabela)); assert.match(chave.definicao, /REFERENCES public\./);
        const definicao = chave.definicao.replace('REFERENCES public.', `REFERENCES ${identificador(esquema)}.`);
        await administracao.query(`ALTER TABLE ${tabela(chave.tabela)} ADD CONSTRAINT ${identificador(chave.nome)} ${definicao}`, { transaction });
      }
    });
    conexao = banco.criarConexao();
    conexao.addHook('afterConnect', (cliente) => cliente.query(`SET search_path TO ${identificador(esquema)}, public`));
    await conexao.authenticate(); validarDestinoTeste(conexao);
    const [estado] = await conexao.query('SELECT current_schema() AS esquema'); assert.equal(estado[0].esquema, esquema);
    pool = new Pool({ connectionString: destino.url, max: 4, options: `-c search_path=${esquema},public` });
    hash = await bcrypt.hash(SENHA, 4);
    // Somente provedores de conexão/sessão são redirecionados. app.js, todas as
    // rotas, Passport, cookies, CSRF, serviços, SQL e persistência são os reais.
    substituicoes.push(mock.method(banco, 'obterConexao', () => conexao));
    substituicoes.push(mock.method(banco, 'verificarConexao', () => conexao.authenticate()));
    substituicoes.push(mock.method(servicoAutenticacao, 'atenderAutenticacao', (req, res, next) => autenticacao.roteador(req, res, next)));
    substituicoes.push(mock.method(servicoAutenticacao, 'identificarRequisicao', (req, res, next) => autenticacao.identificar(req, res, next)));
    app = require('../../app');
  } catch (erro) { await encerrar(); throw erro; }

  async function criar(modelo, dados, transaction) { return conexao.models[modelo].create(dados, { transaction }); }
  async function resetar({ limiteLogin = { maximo: 100 }, limiteCadastro = { maximo: 100 } } = {}) {
    if (autenticacao) await autenticacao.encerrar();
    validar(); await administracao.query(`TRUNCATE TABLE ${tabelas.map(tabela).join(', ')} RESTART IDENTITY`);
    tempoSessao = Date.now(); base = Date.now();
    const configuracao = carregarConfiguracaoSessao({ NODE_ENV: 'test', SESSION_SECRET: SEGREDO, SESSION_COOKIE_SECURE: 'false' });
    autenticacao = criarAutenticacao({ configuracao, pool, obterUsuario: () => conexao.models.Usuario, agora: () => tempoSessao, limiteLogin, limiteCadastro });
    contas = {};
    for (const [nome, perfil, situacao] of [['admin', 'ADMIN_CLUBE', 'ATIVO'], ['a', 'LEITOR', 'ATIVO'], ['b', 'LEITOR', 'ATIVO'], ['pendente', 'LEITOR', 'PENDENTE'], ['inativo', 'LEITOR', 'INATIVO']]) {
      contas[nome] = await criar('Usuario', { nome: `Pessoa ${nome}`, email: `${nome}@transversal.example`, senhaHash: hash, perfil, situacao, sessionVersion: 0 });
    }
  }
  async function csrf(agente) {
    const resposta = conferirResposta(await agente.get('/api/auth/csrf')); assert.equal(resposta.status, 200); return resposta.body.data.csrfToken;
  }
  async function entrar(conta = contas.admin) {
    const agente = supertest.agent(app); const token = await csrf(agente);
    const resposta = conferirResposta(await agente.post('/api/auth/login').set('X-CSRF-Token', token).send({ email: conta.email, senha: SENHA }));
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const cookie = resposta.headers['set-cookie'].find((valor) => valor.startsWith('leia.sid=')).split(';')[0];
    return { agente, cookie, csrf: await csrf(agente), conta };
  }
  async function obra(totalPaginas = 300) {
    const genero = await criar('Genero', { nome: `Gênero ${await conexao.models.Genero.count() + 1}` });
    return criar('Livro', { titulo: 'Obra transversal', autor: 'Autora', generoId: genero.id, totalPaginas });
  }
  function dadosCiclo(livro, extras = {}) {
    return { nome: 'Ciclo transversal', livroId: livro.id, dataInicio: dataEmSaoPaulo(base - 86400000), dataFim: dataEmSaoPaulo(base + 7 * 86400000), ...extras };
  }
  async function ciclo(livro, situacao = 'EM_ANDAMENTO', extras = {}) { return criar('CicloLeitura', { ...dadosCiclo(livro, extras), situacao }); }
  function dadosEncontro(leitura, extras = {}) {
    return { cicloId: leitura.id, titulo: 'Encontro transversal', inicioEm: new Date(base + 2 * 86400000).toISOString(), local: 'Biblioteca', ...extras };
  }
  async function encontro(leitura, extras = {}) { return criar('Encontro', dadosEncontro(leitura, extras)); }
  async function participar(pessoa, leitura, paginaAtual = 0) { return criar('ParticipacaoLeitura', { usuarioId: pessoa.id, cicloId: leitura.id, paginaAtual }); }
  function pedir(identidade, metodo, caminho, corpo, { token = true } = {}) {
    let pedido = supertest(app)[metodo](caminho);
    if (identidade) {
      pedido = pedido.set('Cookie', identidade.cookie);
      if (token) pedido = pedido.set('X-CSRF-Token', identidade.csrf);
    }
    if (corpo !== undefined) pedido = pedido.send(corpo);
    return pedido.then(conferirResposta);
  }
  return { app, conexao, administracao, pool, criar, resetar, encerrar, entrar, csrf, obra, ciclo, encontro, participar, dadosCiclo, dadosEncontro, pedir,
    get contas() { return contas; }, get base() { return base; }, get tempoSessao() { return tempoSessao; },
    set tempoSessao(valor) { tempoSessao = valor; } };
}

function barreira() {
  let sinalizar; let liberar;
  const pronta = new Promise((resolver) => { sinalizar = resolver; }); const liberada = new Promise((resolver) => { liberar = resolver; });
  return { pronta, liberar, async parar() { sinalizar(); await liberada; } };
}

async function comPrazo(promessa) {
  let prazo;
  try { return await Promise.race([promessa, new Promise((_, rejeitar) => { prazo = setTimeout(() => rejeitar(new Error('A barreira transacional não foi alcançada.')), 5000); })]); }
  finally { clearTimeout(prazo); }
}

async function disputarComBloqueio(contexto, cenario, padrao, primeira, segunda) {
  const pausa = barreira(); let primeiroPid; let sinalizarSegundo;
  const segundoPronto = new Promise((resolver) => { sinalizarSegundo = resolver; });
  let segundaIniciada = false;
  const original = cenario.conexao.query;
  const substituida = contexto.mock.method(cenario.conexao, 'query', async function (sql, opcoes) {
    const texto = typeof sql === 'string' ? sql : sql.query;
    const pid = opcoes?.transaction?.connection?.processID;
    if (!primeiroPid && pid && padrao.test(texto)) { primeiroPid = pid; await pausa.parar(); }
    if (segundaIniciada && pid && pid !== primeiroPid) sinalizarSegundo(pid);
    return original.call(this, sql, opcoes);
  });
  const pedidoA = primeira(); let pedidoB;
  try {
    await comPrazo(pausa.pronta); segundaIniciada = true; pedidoB = segunda();
    const segundoPid = await comPrazo(segundoPronto);
    const limite = Date.now() + 4500;
    // Observa o bloqueio real. Cada volta faz I/O PostgreSQL; não há sleeps
    // nem suposição de que lançar a segunda requisição já significa concorrência.
    await comPrazo((async () => {
      for (;;) {
        const [linhas] = await cenario.administracao.query('SELECT $primeiro::integer = ANY(pg_blocking_pids($segundo::integer)) AS bloqueado', {
          bind: { primeiro: primeiroPid, segundo: segundoPid },
        });
        if (linhas[0].bloqueado) return;
        // O watchdog limita a espera; Date.now só limita falhas, não ordena a corrida.
        if (Date.now() >= limite) throw new Error('A segunda transação não bloqueou na primeira.');
      }
    })());
    pausa.liberar(); return await Promise.all([pedidoA, pedidoB]);
  } finally {
    pausa.liberar(); await Promise.allSettled([pedidoA, pedidoB].filter(Boolean)); substituida.mock.restore();
  }
}

module.exports = { criarCenarioTransversal, conferirResposta, disputarComBloqueio, barreira, comPrazo, SENHA, SEGREDO };
