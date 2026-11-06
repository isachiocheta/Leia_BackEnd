'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const caminho = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client } = require('pg');
const supertest = require('supertest');
const bcrypt = require('bcrypt');
const { criarBancoTemporario } = require('../database/banco-temporario');
const { validarBancoTeste } = require('../configuracao/banco');
const { dataEmSaoPaulo } = require('../utilitarios/datas-civis');
const { calendario, asDezoito } = require('../database/demonstracao/plano');
const { lerContrato, criarValidadorTrocas } = require('../contracts/validar');
const { executarNode, backend, sanitizar } = require('./processos');
const { carregarConsulta } = require('../database/consultas/carregar');
const participacoes = require('../repositorios/participacoes');
const { agendaLeitor } = require('../repositorios/inscricoes');
const relatorios = require('../repositorios/relatorios');

async function iniciar(ambiente) {
  const reserva = net.createServer(); reserva.listen(0, '127.0.0.1'); await once(reserva, 'listening');
  const porta = reserva.address().port; await new Promise((resolver) => reserva.close(resolver));
  const filho = spawn(process.execPath, ['server.js'], { cwd: backend, env: { ...ambiente, PORT: String(porta) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; filho.stdout.setEncoding('utf8'); filho.stderr.setEncoding('utf8');
  let terminou = false; const saida = new Promise((resolver) => filho.once('exit', (codigo, sinal) => { terminou = true; resolver({ codigo, sinal }); }));
  async function encerrar() {
    if (!terminou) filho.kill('SIGTERM');
    let prazo;
    try {
      const resultado = await Promise.race([saida, new Promise((_, rejeitar) => { prazo = setTimeout(() => { filho.kill('SIGKILL'); rejeitar(new Error('Servidor não encerrou dentro do prazo.')); }, 15000); })]);
      assert.equal(resultado.codigo, 0, 'server.js deve encerrar graciosamente.');
      assert.equal(sanitizar(logs, ambiente), logs, 'Logs do servidor não podem conter credenciais.');
    } finally { clearTimeout(prazo); }
  }
  try {
    await new Promise((resolver, rejeitar) => {
      const prazo = setTimeout(() => rejeitar(new Error('Servidor não ficou disponível.')), 10000);
      filho.stdout.on('data', (dados) => { logs += dados; if (logs.includes(`http://localhost:${porta}.`)) { clearTimeout(prazo); resolver(); } });
      filho.stderr.on('data', (dados) => { logs += dados; });
      filho.once('error', () => { clearTimeout(prazo); rejeitar(new Error('Não foi possível executar server.js.')); });
      filho.once('exit', () => { clearTimeout(prazo); rejeitar(new Error('Servidor encerrou antes do smoke.')); });
    });
    return { base: `http://127.0.0.1:${porta}`, encerrar };
  } catch (erro) { try { await encerrar(); } catch { /* Preserva a falha de inicialização. */ } throw erro; }
}

async function conferirBdi(conexao, controle) {
  const { ids } = controle.manifesto; const chamadas = []; const original = conexao.query;
  conexao.query = function (sql, opcoes) { chamadas.push({ sql, bind: opcoes?.bind }); return original.call(this, sql, opcoes); };
  try {
    const participantes = await participacoes.participantesCiclo(ids.ciclos.atual, conexao);
    assert.equal(participantes.total, 3); assert.deepEqual(participantes.data.map((linha) => linha.percentual), [0, 50, 100]);
    const resumo = await relatorios.resumoCiclo(ids.ciclos.atual, conexao);
    assert.equal(resumo.participantes, 3); assert.equal(resumo.conclusoes, 1); assert.equal(resumo.mediaProgresso, 50); assert.equal(resumo.taxaConclusao, 33.33);
    const agenda = await agendaLeitor(ids.usuarios.inicio, conexao); assert.equal(agenda.total, 2);
    const livros = await relatorios.livrosMinimoCiclos(2, conexao); assert.equal(livros.length, 1); assert.equal(livros[0].totalCiclos, 2);
    const semAdesao = await relatorios.leitoresSemParticipacao(ids.ciclos.atual, conexao); assert.deepEqual(semAdesao.map((pessoa) => pessoa.id), [ids.usuarios.semParticipacao]);
    const historico = await participacoes.historicoLeituras(ids.usuarios.final, conexao); assert.equal(historico.total, 2); assert.ok(historico.data.every((linha) => linha.genero.nome === 'Romance'));
    for (const nome of ['participantesCiclo', 'resumoCiclo', 'agendaLeitor', 'livrosMinimoCiclos', 'leitoresSemParticipacao', 'historicoLeituras']) {
      const chamada = chamadas.find((item) => item.sql === carregarConsulta(nome)); assert.ok(chamada, nome); assert.ok(chamada.bind && Object.keys(chamada.bind).length > 0);
    }
    assert.equal(chamadas.find((item) => item.sql === carregarConsulta('livrosMinimoCiclos')).bind.minimo, 2);
    assert.equal(chamadas.find((item) => item.sql === carregarConsulta('historicoLeituras')).bind.usuario, ids.usuarios.final);
    assert.deepEqual(await relatorios.livrosMinimoCiclos(999, conexao), []);
    const quantidade = chamadas.length;
    await assert.rejects(relatorios.livrosMinimoCiclos('2 OR 1=1', conexao), TypeError); assert.equal(chamadas.length, quantidade);
    console.info('BDI: seis arquivos parametrizados executados; 3 participantes, média 50, taxa 33,33%, agenda 2, HAVING 2 ciclos, NOT EXISTS 1 leitor, histórico 2 leituras.');
  } finally { conexao.query = original; }
}

async function smoke(temporario, ambiente, contrato) {
  const conexao = temporario.conexao;
  const [controles] = await conexao.query("SELECT manifesto FROM cargas_demonstracao WHERE chave='leia_demo_v1'"); const controle = controles[0];
  await conferirBdi(conexao, controle);
  const { ids } = controle.manifesto;
  const servidor = await iniciar(ambiente); const validador = criarValidadorTrocas(contrato);
  try {
    const agente = () => supertest.agent(servidor.base);
    async function pedir(cliente, metodo, url, corpo, token, esperado = 200) {
      let pedido = cliente[metodo](url); if (token) pedido = pedido.set('X-CSRF-Token', token); if (corpo !== undefined) pedido = pedido.send(corpo);
      const resposta = await pedido;
      assert.equal(resposta.status, esperado, `${metodo} ${url}: status ${resposta.status}`);
      validador.conferir(metodo, url, resposta, corpo);
      assert.doesNotMatch(JSON.stringify(resposta.body), /"senhaHash"|"senha_hash"|"sessionVersion"|"session_version"|"stack"|"sql"/);
      return resposta;
    }
    const token = async (cliente) => (await pedir(cliente, 'get', '/api/auth/csrf')).body.data.csrfToken;
    async function entrar(email, senha, esperado = 200) {
      const cliente = agente(); const csrf = await token(cliente);
      const resposta = await pedir(cliente, 'post', '/api/auth/login', { email, senha }, csrf, esperado);
      if (esperado !== 200) return cliente;
      const cookie = resposta.headers['set-cookie'].find((valor) => valor.startsWith('leia.sid='));
      assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i); assert.doesNotMatch(cookie, /; Secure/i);
      return { cliente, csrf: await token(cliente) };
    }
    const anonimo = agente(); assert.equal((await pedir(anonimo, 'get', '/api/health')).body.data.status, 'ok');
    assert.equal((await pedir(anonimo, 'get', '/api/ready')).body.data.status, 'pronto');
    await pedir(anonimo, 'get', '/api/livros', undefined, undefined, 401);
    const preflight = await anonimo.options('/api/livros').set('Origin', ambiente.ALLOWED_ORIGIN).set('Access-Control-Request-Method', 'POST');
    assert.equal(preflight.status, 204); assert.equal(preflight.headers['access-control-allow-credentials'], 'true'); assert.equal(preflight.headers['access-control-allow-origin'], ambiente.ALLOWED_ORIGIN);
    const admin = await entrar(ambiente.ADMIN_EMAIL, ambiente.ADMIN_SENHA);
    let inicio = await entrar('demo.inicio@leia.example', ambiente.DEMO_SENHA_INICIO);
    const metade = await entrar('demo.metade@leia.example', ambiente.DEMO_SENHA_METADE);
    const final = await entrar('demo.final@leia.example', ambiente.DEMO_SENHA_FINAL);
    const generos = await pedir(admin.cliente, 'get', '/api/generos?page=1&pageSize=50'); assert.equal(generos.body.meta.total, 6);
    await pedir(inicio.cliente, 'get', '/api/dashboard/admin', undefined, undefined, 403);
    const livro = (await pedir(admin.cliente, 'post', '/api/livros', { titulo: 'Obra do smoke', autor: 'Autora', generoId: generos.body.data[0].id, totalPaginas: 120 }, admin.csrf, 201)).body.data;
    await pedir(admin.cliente, 'get', `/api/livros/${livro.id}`);
    await pedir(admin.cliente, 'patch', `/api/livros/${livro.id}`, { titulo: 'Obra smoke editada', descricao: '<b>Texto JSON</b>' }, admin.csrf);
    assert.equal((await pedir(inicio.cliente, 'get', '/api/livros?q=smoke&sort=titulo&direction=asc&page=1&pageSize=12')).body.meta.total, 1);
    const base = ambiente.DEMO_DATA_BASE;
    const ciclo = (await pedir(admin.cliente, 'post', '/api/ciclos', { nome: 'Ciclo smoke', livroId: livro.id, dataInicio: calendario(base, -1), dataFim: calendario(base, 10) }, admin.csrf, 201)).body.data;
    await pedir(inicio.cliente, 'get', `/api/ciclos/${ciclo.id}`);
    await pedir(admin.cliente, 'patch', `/api/ciclos/${ciclo.id}`, { nome: 'Ciclo smoke editado' }, admin.csrf);
    assert.equal((await pedir(admin.cliente, 'get', '/api/ciclos?q=smoke&situacao=PLANEJADO&sort=dataInicio&direction=asc')).body.meta.total, 1);
    const encontro = (await pedir(admin.cliente, 'post', '/api/encontros', { cicloId: ciclo.id, titulo: 'Encontro smoke', inicioEm: asDezoito(calendario(base, 3)).toISOString(), local: 'Biblioteca' }, admin.csrf, 201)).body.data;
    await pedir(inicio.cliente, 'get', `/api/encontros/${encontro.id}`);
    await pedir(admin.cliente, 'patch', `/api/encontros/${encontro.id}`, { titulo: 'Encontro smoke editado', local: 'Sala de leitura' }, admin.csrf);
    assert.equal((await pedir(admin.cliente, 'get', `/api/encontros?q=smoke&cicloId=${ciclo.id}&situacao=AGENDADO&sort=inicioEm&direction=asc`)).body.meta.total, 1);
    await entrar('demo.pendente@leia.example', ambiente.DEMO_SENHA_PENDENTE, 401);
    assert.equal((await pedir(admin.cliente, 'get', '/api/usuarios?situacao=PENDENTE&sort=nome&direction=asc')).body.meta.total, 1);
    await pedir(admin.cliente, 'patch', `/api/usuarios/${ids.usuarios.pendente}/situacao`, { situacao: 'ATIVO' }, admin.csrf);
    const aprovado = await entrar('demo.pendente@leia.example', ambiente.DEMO_SENHA_PENDENTE); await pedir(aprovado.cliente, 'get', '/api/auth/me');
    const cadastro = agente(); const cadastrado = (await pedir(cadastro, 'post', '/api/auth/cadastro', { nome: 'Leitor cadastrado', email: 'cadastro@smoke.example', senha: randomBytes(20).toString('hex') }, await token(cadastro), 201)).body.data;
    assert.equal(cadastrado.situacao, 'PENDENTE'); await pedir(cadastro, 'get', '/api/auth/me', undefined, undefined, 401);
    await pedir(admin.cliente, 'patch', `/api/usuarios/${cadastrado.id}/situacao`, { situacao: 'ATIVO' }, admin.csrf);
    await pedir(inicio.cliente, 'patch', '/api/me', { nome: 'Leitor smoke editado' }, inicio.csrf);
    assert.equal((await pedir(inicio.cliente, 'get', '/api/auth/me')).body.data.nome, 'Leitor smoke editado');
    const outraInicio = await entrar('demo.inicio@leia.example', ambiente.DEMO_SENHA_INICIO); const novaSenha = randomBytes(24).toString('hex');
    const trocada = await pedir(inicio.cliente, 'patch', '/api/me/senha', { senhaAtual: ambiente.DEMO_SENHA_INICIO, novaSenha }, inicio.csrf);
    assert.equal(trocada.body.data.reauthenticate, true);
    for (const sessao of [inicio, outraInicio]) await pedir(sessao.cliente, 'get', '/api/auth/me', undefined, undefined, 401);
    await pedir(final.cliente, 'get', '/api/auth/me'); inicio = await entrar('demo.inicio@leia.example', novaSenha);
    const sem = await entrar('demo.sem.adesao@leia.example', ambiente.DEMO_SENHA_SEM_PARTICIPACAO);
    await pedir(sem.cliente, 'post', `/api/ciclos/${ids.ciclos.atual}/participacoes`, undefined, sem.csrf, 201);
    await pedir(sem.cliente, 'get', `/api/ciclos/${ids.ciclos.atual}/minha-participacao`);
    for (const paginaAtual of [150, 300, 150]) {
      const progresso = (await pedir(sem.cliente, 'patch', `/api/ciclos/${ids.ciclos.atual}/meu-progresso`, { paginaAtual }, sem.csrf)).body.data;
      assert.equal(progresso.percentual, paginaAtual / 3); assert.equal(progresso.concluida, paginaAtual === 300);
    }
    assert.equal((await pedir(sem.cliente, 'get', '/api/me/participacoes')).body.meta.total, 1);
    assert.equal((await pedir(admin.cliente, 'get', `/api/ciclos/${ids.ciclos.atual}/participantes?page=1&pageSize=50`)).body.meta.total, 4);
    await pedir(sem.cliente, 'post', `/api/encontros/${ids.encontros.proximo}/inscricoes`, undefined, sem.csrf, 201);
    assert.equal((await pedir(sem.cliente, 'get', '/api/me/inscricoes?futuros=true')).body.meta.total, 1);
    assert.equal((await pedir(admin.cliente, 'get', `/api/encontros/${ids.encontros.proximo}/inscritos`)).body.meta.total, 3);
    await pedir(sem.cliente, 'delete', `/api/encontros/${ids.encontros.proximo}/minha-inscricao`, undefined, sem.csrf, 204);
    const cascata = (await pedir(admin.cliente, 'post', '/api/encontros', { cicloId: ids.ciclos.atual, titulo: 'Cascata smoke', inicioEm: asDezoito(calendario(base, 4)).toISOString(), local: 'Sala' }, admin.csrf, 201)).body.data;
    await pedir(sem.cliente, 'post', `/api/encontros/${cascata.id}/inscricoes`, undefined, sem.csrf, 201);
    await pedir(admin.cliente, 'delete', `/api/encontros/${cascata.id}`, undefined, admin.csrf, 204);
    assert.equal(await conexao.models.InscricaoEncontro.count({ where: { encontroId: cascata.id } }), 0);
    const painel = (await pedir(admin.cliente, 'get', '/api/dashboard/admin')).body.data;
    assert.equal(painel.cicloAtual.indicadores.participantes, 4); assert.equal(painel.cicloAtual.indicadores.progressoMedio, 50); assert.equal(painel.cicloAtual.indicadores.taxaConclusao, 25);
    assert.equal((await pedir(sem.cliente, 'get', '/api/dashboard/me')).body.data.minhaParticipacao.percentual, 50);
    for (const evento of ['proximo', 'seguinte']) await pedir(admin.cliente, 'patch', `/api/encontros/${ids.encontros[evento]}`, { situacao: 'CANCELADO' }, admin.csrf);
    await pedir(admin.cliente, 'patch', `/api/ciclos/${ids.ciclos.atual}`, { situacao: 'CONCLUIDO' }, admin.csrf);
    assert.equal((await pedir(sem.cliente, 'get', '/api/dashboard/me')).body.data.cicloAtual, null);
    await pedir(admin.cliente, 'delete', `/api/encontros/${encontro.id}`, undefined, admin.csrf, 204);
    await pedir(admin.cliente, 'patch', `/api/ciclos/${ciclo.id}`, { situacao: 'EM_ANDAMENTO' }, admin.csrf);
    await pedir(admin.cliente, 'patch', `/api/ciclos/${ciclo.id}`, { situacao: 'CONCLUIDO' }, admin.csrf);
    await pedir(admin.cliente, 'delete', `/api/ciclos/${ciclo.id}`, undefined, admin.csrf, 204);
    await pedir(admin.cliente, 'delete', `/api/livros/${livro.id}`, undefined, admin.csrf, 204);
    await pedir(admin.cliente, 'get', `/api/livros/${livro.id}`, undefined, undefined, 404);
    assert.equal(await conexao.models.Livro.findByPk(livro.id), null); assert.equal(await conexao.models.CicloLeitura.findByPk(ciclo.id), null);
    assert.equal(await conexao.models.Encontro.findByPk(encontro.id), null);
    const [progressoFinal] = await conexao.query('SELECT pagina_atual,concluida_em FROM participacoes_leitura WHERE usuario_id=$usuario AND ciclo_id=$ciclo', { bind: { usuario: ids.usuarios.semParticipacao, ciclo: ids.ciclos.atual } });
    assert.equal(progressoFinal[0].pagina_atual, 150); assert.equal(progressoFinal[0].concluida_em, null);
    const conta = await conexao.models.Usuario.scope('credenciais').findByPk(ids.usuarios.inicio); assert.equal(conta.sessionVersion, 1); assert.ok(await bcrypt.compare(novaSenha, conta.senhaHash));
    await pedir(inicio.cliente, 'post', '/api/auth/logout', undefined, inicio.csrf, 204);
    await pedir(metade.cliente, 'post', '/api/auth/logout', undefined, metade.csrf, 204);
    assert.equal(validador.cobertas.size, 38, `Operações cobertas: ${[...validador.cobertas].join(', ')}`);
    console.info('Smoke HTTP: 38 operações com schemas válidos; três CRUDs, aprovação, perfil/senha, revogação, progresso, inscrições, cascata e dashboards verificados no banco.');
  } finally { await servidor.encerrar(); }
}

async function verificarInstalacoes(variaveis = process.env) {
  validarBancoTeste(variaveis); const contrato = await lerContrato();
  for (const modo of ['migracoes', 'sql']) {
    const temporario = await criarBancoTemporario(modo, variaveis);
    try {
      console.info(`Instalação isolada pelo caminho ${modo}.`);
      if (modo === 'sql') {
        const cliente = new Client({ connectionString: temporario.variaveis.TEST_DATABASE_URL }); await cliente.connect();
        try { for (const nome of ['001_schema.sql', '002_reference_data.sql', '003_migration_metadata.sql']) await cliente.query(await fs.readFile(caminho.join(backend, 'database/sql', nome), 'utf8')); }
        finally { await cliente.end(); }
      }
      for (const comando of ['db:migrate', 'db:seed:all']) await executarNode('database/executar-cli.js', [comando], temporario.variaveis, { silencioso: true });
      const base = dataEmSaoPaulo(); const ambiente = { ...temporario.variaveis,
        SESSION_SECRET: randomBytes(40).toString('hex'), SESSION_COOKIE_SECURE: 'false', ALLOWED_ORIGIN: 'http://localhost:5173',
        ADMIN_NOME: 'Administrador smoke', ADMIN_EMAIL: 'admin@smoke.example', ADMIN_SENHA: randomBytes(24).toString('hex'), DEMO_DATA_BASE: base };
      for (const chave of ['INICIO', 'METADE', 'FINAL', 'SEM_PARTICIPACAO', 'PENDENTE']) ambiente[`DEMO_SENHA_${chave}`] = randomBytes(24).toString('hex');
      for (const arquivo of ['database/bootstrap-administrativo.js', 'database/carregar-demonstracao.js']) {
        await executarNode(arquivo, [], ambiente, { silencioso: true });
        await executarNode(arquivo, [], ambiente, { silencioso: true });
      }
      assert.equal(await temporario.conexao.models.Usuario.count(), 6); assert.equal(await temporario.conexao.models.Genero.count(), 6);
      await smoke(temporario, ambiente, contrato);
      console.info(`Caminho ${modo}: instalação, referência, bootstrap, demo, inicialização e encerramento confirmados.`);
    } finally { await temporario.encerrar(); }
  }
}

if (require.main === module && !require('../utilitarios/ajuda').exibirAjuda('verificar:instalacao')) verificarInstalacoes().catch((erro) => { console.error(erro.message); process.exitCode = 1; });
module.exports = { verificarInstalacoes };
