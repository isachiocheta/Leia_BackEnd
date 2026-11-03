'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const bcrypt = require('bcrypt');
const supertest = require('supertest');
const { ConnectionError } = require('sequelize');
const { criarCenarioTransversal, conferirResposta, SENHA, SEGREDO } = require('../apoio/cenario-transversal');

// Sondas autorizadas de escrita usam corpo vazio/id inválido: atingem a
// validação real sem mudar o estado durante a matriz. Fluxos válidos e efeitos
// finais são cobertos abaixo e pelas suítes funcionais anteriores, preservadas.
const ambos = ['ADMIN_CLUBE', 'LEITOR']; const admin = ['ADMIN_CLUBE']; const leitor = ['LEITOR'];
const rotasProtegidas = [
  ['get', '/api/auth/me', ambos, 200],
  ['get', '/api/usuarios', admin, 200], ['patch', '/api/usuarios/0/situacao', admin, 422, {}],
  ['patch', '/api/me', ambos, 422, {}], ['patch', '/api/me/senha', ambos, 422, {}],
  ['get', '/api/me/participacoes', ambos, 200], ['get', '/api/me/inscricoes', ambos, 200],
  ['get', '/api/generos', ambos, 200],
  ['get', '/api/livros', ambos, 200], ['get', '/api/livros/0', ambos, 422],
  ['post', '/api/livros', admin, 422, {}], ['patch', '/api/livros/0', admin, 422, {}], ['delete', '/api/livros/0', admin, 422],
  ['get', '/api/ciclos', ambos, 200], ['get', '/api/ciclos/0', ambos, 422],
  ['post', '/api/ciclos', admin, 422, {}], ['patch', '/api/ciclos/0', admin, 422, {}], ['delete', '/api/ciclos/0', admin, 422],
  ['post', '/api/ciclos/0/participacoes', leitor, 422], ['get', '/api/ciclos/0/minha-participacao', ambos, 422],
  ['patch', '/api/ciclos/0/meu-progresso', leitor, 422, {}], ['get', '/api/ciclos/0/participantes', admin, 422],
  ['get', '/api/encontros', ambos, 200], ['get', '/api/encontros/0', ambos, 422],
  ['post', '/api/encontros', admin, 422, {}], ['patch', '/api/encontros/0', admin, 422, {}], ['delete', '/api/encontros/0', admin, 422],
  ['post', '/api/encontros/0/inscricoes', leitor, 422], ['delete', '/api/encontros/0/minha-inscricao', leitor, 422], ['get', '/api/encontros/0/inscritos', admin, 422],
  ['get', '/api/dashboard/admin', admin, 200], ['get', '/api/dashboard/me', leitor, 200],
  // Última operação porque o logout válido destrói a sessão de cada ator.
  ['post', '/api/auth/logout', ambos, 204],
];

describe('Segurança transversal no app.js real, com PostgreSQL, Passport, cookies e CSRF', { timeout: 90_000 }, () => {
  let c;
  before(async () => { c = await criarCenarioTransversal(); });
  beforeEach(async () => c.resetar());
  after(async () => { if (c) await c.encerrar(); });
  async function recusarCookieEmTodasAsRotas(identidade) {
    for (const [metodo, caminho, , , corpo] of rotasProtegidas) {
      assert.equal((await c.pedir(identidade, metodo, caminho, corpo)).status, 401, `${metodo} ${caminho}`);
    }
  }

  it('matriz de todas as rotas protegidas: anônimo, admin, dois leitores, pendente e inativo; CSRF precede validação', async (contexto) => {
    const anonimo = conferirResposta(await supertest(c.app).get('/api/auth/csrf'));
    const sessaoAnonima = { cookie: anonimo.headers['set-cookie'][0].split(';')[0], csrf: anonimo.body.data.csrfToken };
    const atores = [{ nome: 'anônimo', identidade: sessaoAnonima, ativo: false }];
    for (const nome of ['admin', 'a', 'b', 'pendente', 'inativo']) {
      const conta = c.contas[nome]; const situacao = conta.situacao;
      // Cookies válidos, emitidos por login real antes da indisponibilidade.
      // O estado pendente aqui é fixture de segurança, não nova transição HTTP.
      if (situacao !== 'ATIVO') await conta.update({ situacao: 'ATIVO' });
      const identidade = await c.entrar(conta);
      if (situacao !== 'ATIVO') await conta.update({ situacao });
      atores.push({ nome, identidade, ativo: situacao === 'ATIVO' });
    }
    for (const ator of atores) {
      for (const caminho of ['/api/health', '/api/ready', '/api/auth/csrf']) assert.equal((await c.pedir(ator.identidade, 'get', caminho)).status, 200);
      // Nos cookies que se tornaram indisponíveis o SID já foi invalidado:
      // é preciso obter outra sessão/token anônimo para login ou cadastro.
      for (const [caminho, validacao] of [['/api/auth/login', 401], ['/api/auth/cadastro', 422]]) {
        const esperado = ator.ativo || ator.nome === 'anônimo' ? validacao : 403;
        assert.equal((await c.pedir(ator.identidade, 'post', caminho, {})).status, esperado, `${ator.nome}: ${caminho}`);
        assert.equal((await c.pedir(ator.identidade, 'post', caminho, {}, { token: false })).status, 403);
      }
      for (const [metodo, caminho, perfis, sucesso, corpo] of rotasProtegidas) {
        const permitido = ator.ativo && perfis.includes(ator.identidade.conta.perfil);
        const esperado = !ator.ativo ? 401 : permitido ? sucesso : 403;
        if (permitido && metodo !== 'get') assert.equal((await c.pedir(ator.identidade, metodo, caminho, corpo, { token: false })).status, 403, `${ator.nome}: CSRF ${metodo} ${caminho}`);
        assert.equal((await c.pedir(ator.identidade, metodo, caminho, corpo)).status, esperado, `${ator.nome}: ${metodo} ${caminho}`);
      }
    }
    assert.equal(await c.conexao.models.Usuario.count(), 5); assert.equal(await c.conexao.models.ParticipacaoLeitura.count(), 0);
    contexto.diagnostic(`${rotasProtegidas.length} rotas protegidas e 5 públicas × 6 atores; ausência de CSRF nas mutações permitidas.`);
  });

  it('login/cadastro continuam públicos, exigem CSRF real e contas pendentes/inativas têm a mesma recusa', async (contexto) => {
    const mensagens = [];
    for (const metodo of ['error', 'warn', 'log']) contexto.mock.method(console, metodo, (...args) => mensagens.push(args.map(String).join(' ')));
    for (const caminho of ['/api/auth/login', '/api/auth/cadastro']) assert.equal(conferirResposta(await supertest(c.app).post(caminho).send({})).status, 403);
    for (const nome of ['pendente', 'inativo']) {
      const agente = supertest.agent(c.app); const token = await c.csrf(agente);
      const resposta = conferirResposta(await agente.post('/api/auth/login').set('X-CSRF-Token', token).send({ email: c.contas[nome].email, senha: SENHA }));
      assert.equal(resposta.status, 401); assert.equal((await agente.get('/api/auth/me')).status, 401);
    }
    const agente = supertest.agent(c.app); const token = await c.csrf(agente);
    const resposta = conferirResposta(await agente.post('/api/auth/cadastro').set('X-CSRF-Token', token).send({ nome: 'Nova leitora', email: 'nova@transversal.example', senha: SENHA }));
    assert.equal(resposta.status, 201); assert.equal(resposta.body.data.perfil, 'LEITOR'); assert.equal(resposta.body.data.situacao, 'PENDENTE');
    assert.equal((await agente.get('/api/auth/me')).status, 401);
    const persistida = await c.conexao.models.Usuario.scope('credenciais').findByPk(resposta.body.data.id);
    assert.ok(await bcrypt.compare(SENHA, persistida.senhaHash)); assert.equal(persistida.sessionVersion, 0);
    assert.deepEqual(mensagens, []);
  });

  it('titularidade atravessa perfil, participações, progresso, inscrições e dashboards de dois leitores', async () => {
    const leitura = await c.ciclo(await c.obra()); const evento = await c.encontro(leitura);
    const pa = await c.participar(c.contas.a, leitura, 10); const pb = await c.participar(c.contas.b, leitura, 250);
    const a = await c.entrar(c.contas.a); const b = await c.entrar(c.contas.b);
    assert.equal((await c.pedir(a, 'patch', '/api/me', { nome: 'Nome somente A', usuarioId: c.contas.b.id })).status, 422);
    assert.equal((await c.pedir(a, 'patch', '/api/me', { nome: 'Nome somente A' })).status, 200);
    assert.equal((await c.pedir({ ...a, csrf: b.csrf }, 'patch', '/api/me', { nome: 'CSRF de B' })).status, 403);
    await c.contas.a.reload(); await c.contas.b.reload(); assert.equal(c.contas.a.nome, 'Nome somente A'); assert.equal(c.contas.b.nome, 'Pessoa b');
    assert.equal((await c.pedir(a, 'patch', `/api/ciclos/${leitura.id}/meu-progresso`, { paginaAtual: 100, usuarioId: c.contas.b.id })).status, 422);
    assert.equal((await c.pedir(a, 'patch', `/api/ciclos/${leitura.id}/meu-progresso`, { paginaAtual: 100 })).status, 200);
    await pa.reload(); await pb.reload(); assert.equal(pa.paginaAtual, 100); assert.equal(pb.paginaAtual, 250);
    assert.equal((await c.pedir(b, 'post', `/api/encontros/${evento.id}/inscricoes`)).status, 201);
    assert.equal((await c.pedir(a, 'delete', `/api/encontros/${evento.id}/minha-inscricao`)).status, 404);
    assert.equal((await c.pedir(a, 'post', `/api/encontros/${evento.id}/inscricoes`, { usuarioId: c.contas.b.id })).status, 422);
    for (const [identidade, participacao, totalInscricoes] of [[a, pa, 0], [b, pb, 1]]) {
      const minha = await c.pedir(identidade, 'get', `/api/ciclos/${leitura.id}/minha-participacao`); assert.equal(minha.body.data.id, participacao.id);
      const historico = await c.pedir(identidade, 'get', '/api/me/participacoes'); assert.deepEqual(historico.body.data.map((linha) => linha.id), [participacao.id]);
      assert.equal((await c.pedir(identidade, 'get', '/api/me/inscricoes')).body.meta.total, totalInscricoes);
      const dashboard = await c.pedir(identidade, 'get', '/api/dashboard/me'); assert.equal(dashboard.body.data.minhaParticipacao.id, participacao.id); assert.equal(dashboard.body.data.totalInscricoesFuturas, totalInscricoes);
      assert.equal((await c.pedir(identidade, 'get', '/api/auth/me')).body.data.id, identidade.conta.id);
    }
    const [inscricao] = await c.conexao.models.InscricaoEncontro.findAll(); assert.equal(inscricao.usuarioId, c.contas.b.id);
  });

  it('troca real de senha revoga dois cookies em todas as rotas, preserva outro leitor e o histórico', async () => {
    const leitura = await c.ciclo(await c.obra()); const participacao = await c.participar(c.contas.a, leitura, 100);
    const a = await c.entrar(c.contas.a); const outraA = await c.entrar(c.contas.a); const b = await c.entrar(c.contas.b);
    const resposta = await c.pedir(a, 'patch', '/api/me/senha', { senhaAtual: SENHA, novaSenha: `${SENHA} Nova` });
    assert.equal(resposta.status, 200); assert.deepEqual(resposta.body, { data: { reauthenticate: true } });
    await recusarCookieEmTodasAsRotas(a); await recusarCookieEmTodasAsRotas(outraA);
    assert.equal((await c.pedir(b, 'get', '/api/auth/me')).status, 200);
    assert.equal((await c.pedir(b, 'get', '/api/dashboard/me')).status, 200);
    const usuario = await c.conexao.models.Usuario.scope('credenciais').findByPk(c.contas.a.id);
    assert.equal(usuario.sessionVersion, 1); assert.ok(await bcrypt.compare(`${SENHA} Nova`, usuario.senhaHash)); assert.equal(await bcrypt.compare(SENHA, usuario.senhaHash), false);
    assert.equal((await participacao.reload()).paginaAtual, 100); assert.equal(await c.conexao.models.ParticipacaoLeitura.count(), 1);
  });

  it('desativar/reativar pela API nunca restaura cookies antigos, mesmo não usados durante a desativação', async () => {
    const leitura = await c.ciclo(await c.obra()); const participacao = await c.participar(c.contas.a, leitura, 100);
    const a = await c.entrar(c.contas.a); const outraA = await c.entrar(c.contas.a); const b = await c.entrar(c.contas.b); const administrador = await c.entrar();
    for (const situacao of ['INATIVO', 'ATIVO']) assert.equal((await c.pedir(administrador, 'patch', `/api/usuarios/${c.contas.a.id}/situacao`, { situacao })).status, 200);
    await c.contas.a.reload(); assert.equal(c.contas.a.situacao, 'ATIVO'); assert.equal(c.contas.a.sessionVersion, 2); assert.equal(c.contas.a.perfil, 'LEITOR');
    await recusarCookieEmTodasAsRotas(a); await recusarCookieEmTodasAsRotas(outraA);
    assert.equal((await c.pedir(b, 'get', '/api/auth/me')).status, 200);
    assert.equal((await c.pedir(await c.entrar(c.contas.a), 'get', '/api/dashboard/me')).status, 200);
    assert.equal((await participacao.reload()).paginaAtual, 100);
  });

  it('cookie expirado é recusado em todas as rotas e polling não altera o prazo persistido', async () => {
    const a = await c.entrar(c.contas.a);
    const carregar = async () => (await c.pool.query("SELECT sess, expire FROM sessoes WHERE sess->'passport'->'user'->>'id' = $1", [String(c.contas.a.id)])).rows;
    const antes = await carregar(); assert.equal(antes.length, 1);
    c.tempoSessao += 15 * 60 * 1000;
    assert.equal((await c.pedir(a, 'get', '/api/dashboard/me')).status, 200); assert.equal((await c.pedir(a, 'get', '/api/auth/me')).status, 200);
    assert.deepEqual(await carregar(), antes);
    c.tempoSessao = antes[0].sess.expiraEm; await recusarCookieEmTodasAsRotas(a);
    assert.equal(await c.conexao.models.Usuario.count(), 5);
  });

  it('SQL Injection é valor parametrizado; privilégios e ordenação inválida são rejeitados; marcação permanece texto JSON', async () => {
    const administrador = await c.entrar(); const a = await c.entrar(c.contas.a); const obra = await c.obra();
    const ataque = "' OR 1=1; DROP TABLE usuarios; -- %_";
    const marcacao = '<script>alert("texto")</script><img src=x onerror=alert(1)>';
    const criada = await c.pedir(administrador, 'post', '/api/livros', { titulo: ataque, autor: marcacao, generoId: obra.generoId, totalPaginas: 100, descricao: marcacao });
    assert.equal(criada.status, 201); assert.equal(criada.body.data.titulo, ataque); assert.equal(criada.body.data.descricao, marcacao);
    const lista = conferirResposta(await supertest(c.app).get('/api/livros').set('Cookie', a.cookie).query({ q: ataque }));
    assert.equal(lista.status, 200); assert.equal(lista.body.meta.total, 1); assert.equal(lista.body.data[0].id, criada.body.data.id);
    const detalhe = await c.pedir(a, 'get', `/api/livros/${criada.body.data.id}`); assert.match(detalhe.headers['content-type'], /application\/json/); assert.equal(detalhe.body.data.autor, marcacao);
    // Nenhuma afirmação de segurança de renderização: ainda não há frontend.
    for (const caminho of ['/api/livros', '/api/ciclos', '/api/encontros', '/api/usuarios']) {
      const identidade = caminho === '/api/usuarios' ? administrador : a;
      const resposta = conferirResposta(await supertest(c.app).get(caminho).set('Cookie', identidade.cookie).query({ sort: 'id; DROP TABLE usuarios', direction: 'desc' })); assert.equal(resposta.status, 422);
    }
    assert.equal((await c.pedir(a, 'get', '/api/livros/1%20OR%201=1')).status, 422);
    const direcao = conferirResposta(await supertest(c.app).get('/api/livros').set('Cookie', a.cookie).query({ direction: 'asc; SELECT 1' })); assert.equal(direcao.status, 422);
    for (const extra of [{ perfil: 'ADMIN_CLUBE' }, { situacao: 'ATIVO' }, { sessionVersion: 0 }]) {
      assert.equal((await c.pedir(a, 'patch', '/api/me', { nome: 'Escalada recusada', ...extra })).status, 422);
      assert.equal((await c.pedir(administrador, 'post', '/api/auth/cadastro', { nome: 'Escalada recusada', email: 'injetado@transversal.example', senha: SENHA, ...extra })).status, 422);
    }
    await c.contas.a.reload(); assert.equal(c.contas.a.perfil, 'LEITOR'); assert.equal(c.contas.a.sessionVersion, 0);
    assert.equal(await c.conexao.models.Usuario.count(), 5); assert.equal(await c.conexao.models.Livro.count(), 2);
    const persistida = await c.conexao.models.Livro.findByPk(criada.body.data.id); assert.equal(persistida.titulo, ataque); assert.equal(persistida.descricao, marcacao);
  });

  it('400/401/403/404/409/413/422/500/503 mantêm contrato seguro e logs sem segredos em rotas existentes', async (contexto) => {
    const mensagens = [];
    for (const metodo of ['error', 'warn', 'log']) contexto.mock.method(console, metodo, (...args) => mensagens.push(args.map(String).join(' ')));
    const administrador = await c.entrar(); const a = await c.entrar(c.contas.a); const obra = await c.obra(); await c.ciclo(obra);
    const codigos = new Set();
    const registrar = (resposta, status) => { conferirResposta(resposta); assert.equal(resposta.status, status); codigos.add(status); };
    registrar(await supertest(c.app).patch('/api/me').set('Cookie', a.cookie).set('X-CSRF-Token', a.csrf).type('json').send('{"nome":"SEGREDO_INTERNO_TRANSVERSAL"'), 400);
    registrar(await c.pedir(null, 'get', '/api/auth/me'), 401);
    registrar(await c.pedir(a, 'get', '/api/dashboard/admin'), 403);
    registrar(await c.pedir(a, 'get', '/api/livros/2147483647'), 404);
    registrar(await c.pedir(administrador, 'delete', `/api/livros/${obra.id}`), 409);
    registrar(await c.pedir(a, 'patch', '/api/me', { nome: `SEGREDO_INTERNO_TRANSVERSAL${'x'.repeat(110000)}` }), 413);
    registrar(await c.pedir(a, 'patch', '/api/me', { perfil: 'ADMIN_CLUBE' }), 422);
    const original = c.conexao.query;
    for (const [status, erro] of [[500, new Error('SEGREDO_INTERNO_TRANSVERSAL SELECT senha_hash FROM usuarios')], [503, new ConnectionError(new Error('SEGREDO_INTERNO_TRANSVERSAL postgres://usuario:senha@host/banco'))]]) {
      const substituida = contexto.mock.method(c.conexao, 'query', async function (sql, opcoes) {
        if (typeof sql === 'string' && sql.includes('FROM livros')) throw erro;
        return original.call(this, sql, opcoes);
      });
      try { registrar(await c.pedir(a, 'get', '/api/livros'), status); } finally { substituida.mock.restore(); }
    }
    assert.deepEqual([...codigos].sort((a, b) => a - b), [400, 401, 403, 404, 409, 413, 422, 500, 503]);
    assert.ok(mensagens.includes('Erro interno ao processar requisição.'));
    const logs = mensagens.join('\n');
    for (const segredo of [SENHA, SEGREDO, a.cookie, a.csrf, administrador.cookie, administrador.csrf, 'SEGREDO_INTERNO_TRANSVERSAL']) assert.ok(!logs.includes(segredo));
    assert.doesNotMatch(logs, /senha_hash|postgres(?:ql)?:\/\/|SELECT |\$2[aby]\$| at .*\.js:/);
    assert.equal(await c.conexao.models.Usuario.count(), 5); assert.equal(await c.conexao.models.Livro.count(), 1);
  });

  it('429 real de login/cadastro tem Retry-After, não registra credenciais e não escreve usuários extras', async (contexto) => {
    await c.resetar({ limiteLogin: { maximo: 1 }, limiteCadastro: { maximo: 1 } });
    const logs = []; contexto.mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' ')));
    const agente = supertest.agent(c.app); const token = await c.csrf(agente);
    for (const [caminho, primeiro] of [['/api/auth/login', 401], ['/api/auth/cadastro', 422]]) {
      const corpo = { email: 'ausente@transversal.example', senha: 'SEGREDO_INTERNO_TRANSVERSAL' };
      assert.equal(conferirResposta(await agente.post(caminho).set('X-CSRF-Token', token).send(corpo)).status, primeiro);
      const resposta = conferirResposta(await agente.post(caminho).set('X-CSRF-Token', token).send(corpo));
      assert.equal(resposta.status, 429); assert.equal(resposta.body.error.code, 'TOO_MANY_REQUESTS'); assert.ok(Number(resposta.headers['retry-after']) > 0);
    }
    assert.deepEqual(logs, []); assert.equal(await c.conexao.models.Usuario.count(), 5);
  });
});
