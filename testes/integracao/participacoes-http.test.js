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
const { criarRotasCiclos } = require('../../ciclos/rotas');
const { criarRotasPerfil } = require('../../perfil/rotas');
const { configurarHttp } = require('../../intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('../../intermediarios/erros');
const { reservarCiclosAtivos } = require('../apoio/coordenacao-ciclos');
const { dataEmSaoPaulo } = require('../../utilitarios/datas-civis');

const destino = validarBancoTeste(process.env);
const configuracao = carregarConfiguracaoSessao({ NODE_ENV: 'test', SESSION_SECRET: 'Segredo exclusivo das fixtures de participação Leia+', SESSION_COOKIE_SECURE: 'false' });
const senha = 'Senha das fixtures de participação';
const prefixo = `participacoes-http-${process.pid}-${Date.now()}`;

describe('Participação e progresso HTTP no PostgreSQL isolado', { timeout: 60_000 }, () => {
  let conexao; let hash; let liberarCiclos; let sequencia = 0;
  const ids = Object.fromEntries(['Usuario', 'Genero', 'Livro', 'CicloLeitura', 'ParticipacaoLeitura'].map((modelo) => [modelo, new Set()]));
  const sids = new Set();
  before(async () => {
    liberarCiclos = await reservarCiclosAtivos(); conexao = criarConexao(); validarDestinoTeste(conexao);
    await conexao.authenticate(); hash = await bcrypt.hash(senha, 4);
  });
  after(async () => {
    try {
      if (conexao) {
        try {
          validarDestinoTeste(conexao); await conexao.query('DELETE FROM sessoes WHERE sid = ANY($1::varchar[])', { bind: [[...sids]] });
          for (const modelo of ['ParticipacaoLeitura', 'CicloLeitura', 'Livro', 'Genero', 'Usuario']) {
            validarDestinoTeste(conexao); if (ids[modelo].size) await conexao.models[modelo].destroy({ where: { id: [...ids[modelo]] } });
          }
        } finally { await conexao.close(); }
      }
    } finally { if (liberarCiclos) await liberarCiclos(); }
  });
  async function criar(modelo, dados) {
    const registro = await conexao.models[modelo].create(dados); ids[modelo].add(registro.id); return registro;
  }
  async function ciclo({ totalPaginas = 100, ...extras } = {}) {
    sequencia += 1; const genero = await criar('Genero', { nome: `${prefixo}-${sequencia}` });
    const livro = await criar('Livro', { titulo: 'Obra do progresso', autor: 'Autora', generoId: genero.id, totalPaginas });
    return criar('CicloLeitura', { nome: 'Ciclo da participação', livroId: livro.id, dataInicio: '2026-11-01', dataFim: '2026-11-03', situacao: 'EM_ANDAMENTO', ...extras });
  }
  function usuario(perfil = 'LEITOR', extras = {}) {
    sequencia += 1; return criar('Usuario', { nome: `Pessoa ${sequencia}`, email: `${prefixo}-${sequencia}@escola.example`, senhaHash: hash, perfil, situacao: 'ATIVO', sessionVersion: 0, ...extras });
  }
  function registrar(resposta) {
    for (const cookie of resposta.headers['set-cookie'] || []) {
      const valor = decodeURIComponent(cookie.split(';')[0].slice('leia.sid='.length));
      if (cookie.startsWith('leia.sid=') && valor.startsWith('s:')) sids.add(valor.slice(2, valor.lastIndexOf('.')));
    }
    assert.doesNotMatch(JSON.stringify(resposta.body), /senhaHash|senha_hash|sessionVersion|session_version|"sql"|"stack"/); return resposta;
  }
  async function token(agente) {
    const resposta = registrar(await agente.get('/api/auth/csrf')); assert.equal(resposta.status, 200); return resposta.body.data.csrfToken;
  }
  async function entrar(agente, conta = null) {
    const pessoa = conta || await usuario(); const csrf = await token(agente);
    assert.equal(registrar(await agente.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email: pessoa.email, senha })).status, 200);
    return { conta: pessoa, csrf: await token(agente) };
  }
  async function aderir(agente, csrf, id, corpo) {
    const pedido = agente.post(`/api/ciclos/${id}/participacoes`).set('X-CSRF-Token', csrf);
    if (corpo !== undefined) pedido.send(corpo);
    const resposta = registrar(await pedido); if (resposta.status === 201) ids.ParticipacaoLeitura.add(resposta.body.data.id); return resposta;
  }
  async function progresso(agente, csrf, id, paginaAtual, extras = {}) { return registrar(await agente.patch(`/api/ciclos/${id}/meu-progresso`).set('X-CSRF-Token', csrf).send({ paginaAtual, ...extras })); }
  async function minha(agente, id) { return registrar(await agente.get(`/api/ciclos/${id}/minha-participacao`)); }
  async function encerrar(agente, csrf, id) { return registrar(await agente.patch(`/api/ciclos/${id}`).set('X-CSRF-Token', csrf).send({ situacao: 'CONCLUIDO' })); }
  async function emAplicacao(executar, { agora = () => Date.parse('2026-11-01T15:00:00Z') } = {}) {
    const pool = new Pool({ connectionString: destino.url, max: 3 }); const autenticacao = criarAutenticacao({ configuracao, pool, obterUsuario: () => conexao.models.Usuario });
    const app = express(); configurarHttp(app, { origemPermitida: 'http://localhost:5173' });
    app.use('/api/auth', autenticacao.roteador);
    app.use('/api/ciclos', autenticacao.identificar, criarRotasCiclos({ obterConexao: () => conexao, agora }));
    app.use('/api/me', autenticacao.identificar, criarRotasPerfil({ obterUsuario: () => conexao.models.Usuario, obterConexao: () => conexao }));
    app.use(rotaNaoEncontrada); app.use(tratarErros);
    try { await executar({ app, agente: supertest.agent(app) }); }
    finally {
      // Libera apenas o ciclo ativo desta suíte entre cenários que compartilham
      // o índice global. A aplicação não deriva situação nem altera ciclos aqui.
      validarDestinoTeste(conexao);
      await conexao.models.CicloLeitura.update({ situacao: 'CONCLUIDO' }, { where: { id: [...ids.CicloLeitura], situacao: 'EM_ANDAMENTO' } });
      await autenticacao.encerrar(); await pool.end();
    }
  }
  function barreira() {
    let sinalizar; let liberar; const pronta = new Promise((resolver) => { sinalizar = resolver; }); const liberada = new Promise((resolver) => { liberar = resolver; });
    return { pronta, liberar, async parar() { sinalizar(); await liberada; } };
  }
  async function aguardar(sinal) {
    let prazo; try { await Promise.race([sinal, new Promise((_, rejeitar) => { prazo = setTimeout(() => rejeitar(new Error('O escritor não atingiu o ponto de sincronização.')), 3000); })]); }
    finally { clearTimeout(prazo); }
  }

  it('adesão usa sessão, inicia em zero e rejeita duplicidade concorrente entre duas sessões', async () => {
    const existente = await ciclo(); const pessoa = await usuario();
    await emAplicacao(async ({ app, agente }) => {
      const outra = supertest.agent(app); const a = await entrar(agente, pessoa); const b = await entrar(outra, pessoa);
      const respostas = await Promise.all([aderir(agente, a.csrf, existente.id), aderir(outra, b.csrf, existente.id, {})]);
      assert.deepEqual(respostas.map((resposta) => resposta.status).sort(), [201, 409]);
      const participacao = respostas.find((resposta) => resposta.status === 201).body.data;
      assert.equal(participacao.paginaAtual, 0); assert.equal(participacao.percentual, 0); assert.equal(participacao.concluida, false); assert.equal(participacao.concluidaEm, null);
      assert.equal(await conexao.models.ParticipacaoLeitura.count({ where: { usuarioId: pessoa.id, cicloId: existente.id } }), 1);
      assert.equal((await minha(agente, existente.id)).body.data.id, participacao.id);
    });
  });

  it('titularidade, perfil, atividade e CSRF protegem adesão, progresso e participantes', async () => {
    const existente = await ciclo(); const titular = await usuario(); const outra = await usuario();
    await emAplicacao(async ({ app, agente }) => {
      assert.equal((await minha(agente, existente.id)).status, 401);
      assert.equal(registrar(await agente.get('/api/me/participacoes')).status, 401);
      const a = await entrar(agente, titular); assert.equal((await aderir(agente, a.csrf, existente.id)).status, 201);
      const outro = supertest.agent(app); const b = await entrar(outro, outra);
      assert.equal((await minha(outro, existente.id)).status, 404);
      assert.equal((await progresso(outro, b.csrf, existente.id, 10)).status, 404);
      assert.equal(registrar(await outro.get('/api/me/participacoes')).body.meta.total, 0);
      assert.equal(registrar(await outro.get(`/api/ciclos/${existente.id}/participantes`)).status, 403);
      assert.equal((await progresso(agente, a.csrf, existente.id, 10, { usuarioId: outra.id })).status, 422);
      assert.equal(registrar(await agente.get(`/api/ciclos/${existente.id}/minha-participacao`).query({ usuarioId: outra.id })).status, 422);
      assert.equal(registrar(await agente.patch(`/api/ciclos/${existente.id}/meu-progresso`).send({ paginaAtual: 10 })).status, 403);
      assert.equal(registrar(await outro.post(`/api/ciclos/${existente.id}/participacoes`)).status, 403);
      const administrador = supertest.agent(app); const admin = await entrar(administrador, await usuario('ADMIN_CLUBE'));
      assert.equal((await aderir(administrador, admin.csrf, existente.id)).status, 403);
      assert.equal((await progresso(administrador, admin.csrf, existente.id, 10)).status, 403);
      await titular.update({ situacao: 'INATIVO', sessionVersion: 1 });
      assert.equal((await progresso(agente, a.csrf, existente.id, 10)).status, 401);
      assert.equal(await conexao.models.ParticipacaoLeitura.count({ where: { usuarioId: outra.id } }), 0);
    });
  });

  it('corpo aceita somente página inteira e limites; cliente não define conclusão ou percentual', async () => {
    const existente = await ciclo();
    await emAplicacao(async ({ agente }) => {
      const { csrf, conta } = await entrar(agente);
      for (const corpo of [{ usuarioId: conta.id }, { paginaAtual: 0 }, { percentual: 100 }, { concluidaEm: null }]) assert.equal((await aderir(agente, csrf, existente.id, corpo)).status, 422);
      assert.equal((await aderir(agente, csrf, existente.id)).status, 201);
      for (const pagina of [-1, 101, 1.5, '1', null, true]) assert.equal((await progresso(agente, csrf, existente.id, pagina)).status, 422);
      for (const extra of [{ percentual: 100 }, { concluidaEm: '2026-11-01T15:00:00Z' }, { usuarioId: conta.id }]) assert.equal((await progresso(agente, csrf, existente.id, 1, extra)).status, 422);
      assert.equal(registrar(await agente.patch(`/api/ciclos/${existente.id}/meu-progresso`).set('X-CSRF-Token', csrf).send({})).status, 422);
      assert.equal((await progresso(agente, csrf, existente.id, 0)).status, 200);
      assert.equal((await progresso(agente, csrf, existente.id, 100)).status, 200);
      assert.equal(registrar(await agente.delete(`/api/ciclos/${existente.id}/participacoes`).set('X-CSRF-Token', csrf)).status, 404);
      assert.equal(registrar(await agente.delete('/api/me/participacoes').set('X-CSRF-Token', csrf)).status, 404);
    });
  });

  it('divisão é decimal e conclusão nunca depende do percentual arredondado', async () => {
    const grande = await ciclo({ totalPaginas: 20000 });
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente); await aderir(agente, csrf, grande.id);
      const quase = await progresso(agente, csrf, grande.id, 19999);
      assert.equal(quase.status, 200); assert.equal(quase.body.data.percentual, 100);
      assert.equal(quase.body.data.concluida, false); assert.equal(quase.body.data.concluidaEm, null);
    });
    const pequena = await ciclo({ totalPaginas: 3 });
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente); await aderir(agente, csrf, pequena.id);
      const terco = await progresso(agente, csrf, pequena.id, 1);
      assert.equal(terco.body.data.percentual, 33.33); assert.equal(terco.body.data.concluida, false);
    });
  });

  it('chegar ao total data uma vez, repetição preserva, recuar limpa e nova conclusão registra outro instante', async () => {
    const existente = await ciclo(); let agora = Date.parse('2026-11-01T15:00:00Z');
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente); const adesao = await aderir(agente, csrf, existente.id);
      const concluida = await progresso(agente, csrf, existente.id, 100); const primeira = concluida.body.data.concluidaEm;
      assert.equal(primeira, new Date(agora).toISOString()); assert.equal(concluida.body.data.concluida, true);
      agora += 1000; const repetida = await progresso(agente, csrf, existente.id, 100); assert.equal(repetida.body.data.concluidaEm, primeira);
      const recuo = await progresso(agente, csrf, existente.id, 99); assert.equal(recuo.body.data.concluidaEm, null); assert.equal(recuo.body.data.concluida, false);
      agora += 1000; const nova = await progresso(agente, csrf, existente.id, 100); assert.notEqual(nova.body.data.concluidaEm, primeira); assert.equal(nova.body.data.concluidaEm, new Date(agora).toISOString());
      const persistida = await conexao.models.ParticipacaoLeitura.findByPk(adesao.body.data.id);
      assert.equal(persistida.paginaAtual, 100); assert.equal(persistida.concluidaEm.toISOString(), nova.body.data.concluidaEm);
    }, { agora: () => agora });
  });

  it('somente EM_ANDAMENTO dentro do período permite gravar, incluindo o último dia integral', async () => {
    const existente = await ciclo(); const planejado = await ciclo({ situacao: 'PLANEJADO' }); const concluido = await ciclo({ situacao: 'CONCLUIDO' });
    let agora = Date.parse('2026-11-04T02:59:59.999Z');
    await emAplicacao(async ({ app, agente }) => {
      const { csrf } = await entrar(agente);
      assert.equal((await aderir(agente, csrf, planejado.id)).status, 409); assert.equal((await aderir(agente, csrf, concluido.id)).status, 409);
      assert.equal((await aderir(agente, csrf, existente.id)).status, 201); assert.equal((await progresso(agente, csrf, existente.id, 10)).status, 200);
      agora = Date.parse('2026-11-04T03:00:00Z');
      const outro = supertest.agent(app); const b = await entrar(outro);
      assert.equal((await aderir(outro, b.csrf, existente.id)).status, 409); assert.equal((await progresso(agente, csrf, existente.id, 11)).status, 409);
      assert.equal((await minha(agente, existente.id)).body.data.paginaAtual, 10);
      assert.equal(registrar(await agente.get('/api/me/participacoes')).body.meta.total, 1);
      agora = Date.parse('2026-11-01T02:59:59.999Z'); assert.equal((await aderir(outro, b.csrf, existente.id)).status, 409);
    }, { agora: () => agora });
  });

  it('histórico próprio sobrevive ao encerramento e participantes administrativos expõem somente id e nome do usuário', async () => {
    const existente = await ciclo(); const pessoa = await usuario(); const outra = await usuario();
    await criar('ParticipacaoLeitura', { usuarioId: outra.id, cicloId: existente.id, paginaAtual: 20 });
    await emAplicacao(async ({ app, agente }) => {
      const { csrf } = await entrar(agente, pessoa); const propria = await aderir(agente, csrf, existente.id); await progresso(agente, csrf, existente.id, 10);
      const administrador = supertest.agent(app); const admin = await entrar(administrador, await usuario('ADMIN_CLUBE'));
      const participantes = registrar(await administrador.get(`/api/ciclos/${existente.id}/participantes`).query({ pageSize: 1, page: 2 }));
      assert.equal(participantes.status, 200); assert.deepEqual(participantes.body.meta, { page: 2, pageSize: 1, total: 2 });
      assert.deepEqual(Object.keys(participantes.body.data[0].usuario).sort(), ['id', 'nome']);
      assert.equal(participantes.body.data[0].usuario.id, pessoa.id);
      assert.equal((await encerrar(administrador, admin.csrf, existente.id)).status, 200);
      assert.equal((await progresso(agente, csrf, existente.id, 11)).status, 409);
      const historico = registrar(await agente.get('/api/me/participacoes').query({ page: 1, pageSize: 1 }));
      assert.deepEqual(historico.body.meta, { page: 1, pageSize: 1, total: 1 }); assert.equal(historico.body.data[0].id, propria.body.data.id);
      assert.equal(historico.body.data[0].ciclo.situacao, 'CONCLUIDO'); assert.equal(historico.body.data[0].paginaAtual, 10);
      assert.equal((await minha(agente, existente.id)).status, 200);
      assert.equal(registrar(await agente.get('/api/me/participacoes').query({ usuarioId: outra.id })).status, 422);
      assert.equal(registrar(await administrador.get('/api/ciclos/2147483647/participantes')).status, 404);
      assert.equal(registrar(await administrador.get(`/api/ciclos/${existente.id}/participantes`).query({ pageSize: 51 })).status, 422);
    });
  });

  it('adesão e encerramento concorrentes se coordenam nas duas ordens', async (contexto) => {
    const primeiro = await ciclo();
    await emAplicacao(async ({ app, agente }) => {
      const { csrf } = await entrar(agente); const administrador = supertest.agent(app); const admin = await entrar(administrador, await usuario('ADMIN_CLUBE'));
      const a = barreira(); const criarOriginal = conexao.models.ParticipacaoLeitura.create;
      contexto.mock.method(conexao.models.ParticipacaoLeitura, 'create', async function (dados, opcoes) { if (dados.cicloId === primeiro.id) await a.parar(); return criarOriginal.call(this, dados, opcoes); });
      const adesao = aderir(agente, csrf, primeiro.id);
      try {
        await aguardar(a.pronta); const fim = encerrar(administrador, admin.csrf, primeiro.id); a.liberar();
        const respostas = await Promise.all([adesao, fim]); assert.equal(respostas[0].status, 201); assert.equal(respostas[1].status, 200);
        assert.equal((await minha(agente, primeiro.id)).body.data.ciclo.situacao, 'CONCLUIDO');
      } finally { a.liberar(); }
      const segundo = await ciclo(); const b = barreira(); const atualizarOriginal = conexao.models.CicloLeitura.prototype.update;
      contexto.mock.method(conexao.models.CicloLeitura.prototype, 'update', async function (dados, opcoes) { if (this.id === segundo.id) await b.parar(); return atualizarOriginal.call(this, dados, opcoes); });
      const fim = encerrar(administrador, admin.csrf, segundo.id);
      try {
        await aguardar(b.pronta); const tentativa = aderir(agente, csrf, segundo.id); b.liberar();
        const respostas = await Promise.all([fim, tentativa]); assert.equal(respostas[0].status, 200); assert.equal(respostas[1].status, 409);
        assert.equal((await minha(agente, segundo.id)).status, 404);
      } finally { b.liberar(); }
    });
  });

  it('progresso e encerramento concorrentes se coordenam nas duas ordens sem escrita tardia', async (contexto) => {
    const primeiro = await ciclo();
    await emAplicacao(async ({ app, agente }) => {
      const { csrf } = await entrar(agente); await aderir(agente, csrf, primeiro.id);
      const administrador = supertest.agent(app); const admin = await entrar(administrador, await usuario('ADMIN_CLUBE'));
      const a = barreira(); const atualizarParticipacao = conexao.models.ParticipacaoLeitura.prototype.update;
      contexto.mock.method(conexao.models.ParticipacaoLeitura.prototype, 'update', async function (dados, opcoes) { if (this.cicloId === primeiro.id) await a.parar(); return atualizarParticipacao.call(this, dados, opcoes); });
      const atualizacao = progresso(agente, csrf, primeiro.id, 5);
      try {
        await aguardar(a.pronta); const fim = encerrar(administrador, admin.csrf, primeiro.id); a.liberar();
        const respostas = await Promise.all([atualizacao, fim]); assert.equal(respostas[0].status, 200); assert.equal(respostas[1].status, 200);
        assert.equal((await minha(agente, primeiro.id)).body.data.paginaAtual, 5);
      } finally { a.liberar(); }
      const segundo = await ciclo(); await aderir(agente, csrf, segundo.id); const b = barreira(); const atualizarCiclo = conexao.models.CicloLeitura.prototype.update;
      contexto.mock.method(conexao.models.CicloLeitura.prototype, 'update', async function (dados, opcoes) { if (this.id === segundo.id) await b.parar(); return atualizarCiclo.call(this, dados, opcoes); });
      const fim = encerrar(administrador, admin.csrf, segundo.id);
      try {
        await aguardar(b.pronta); const tentativa = progresso(agente, csrf, segundo.id, 10); b.liberar();
        const respostas = await Promise.all([fim, tentativa]); assert.equal(respostas[0].status, 200); assert.equal(respostas[1].status, 409);
        assert.equal((await minha(agente, segundo.id)).body.data.paginaAtual, 0);
      } finally { b.liberar(); }
    });
  });

  it('o app público monta as cinco rotas sem oferecer exclusão de participação', async () => {
    const hoje = dataEmSaoPaulo(); const existente = await ciclo({ dataInicio: hoje, dataFim: hoje });
    const pessoa = await usuario(); const gestor = await usuario('ADMIN_CLUBE');
    const anteriores = Object.fromEntries(['SESSION_SECRET', 'SESSION_COOKIE_SECURE', 'ALLOWED_ORIGIN'].map((chave) => [chave, process.env[chave]]));
    process.env.SESSION_SECRET = configuracao.segredo; process.env.SESSION_COOKIE_SECURE = 'false'; process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
    try {
      const app = require('../../app'); const agente = supertest.agent(app); const { csrf } = await entrar(agente, pessoa);
      assert.equal((await aderir(agente, csrf, existente.id)).status, 201); assert.equal((await minha(agente, existente.id)).status, 200);
      assert.equal((await progresso(agente, csrf, existente.id, 10)).status, 200); assert.equal(registrar(await agente.get('/api/me/participacoes')).status, 200);
      const administrador = supertest.agent(app); await entrar(administrador, gestor);
      assert.equal(registrar(await administrador.get(`/api/ciclos/${existente.id}/participantes`)).status, 200);
    } finally {
      await require('../../autenticacao/servico').encerrarAutenticacao(); await require('../../database/conexao').encerrarConexao();
      for (const [chave, valor] of Object.entries(anteriores)) { if (valor === undefined) delete process.env[chave]; else process.env[chave] = valor; }
      validarDestinoTeste(conexao); await conexao.models.CicloLeitura.update({ situacao: 'CONCLUIDO' }, { where: { id: existente.id } });
    }
  });
});
