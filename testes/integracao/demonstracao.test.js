'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const bcrypt = require('bcrypt');
const { spawnSync } = require('node:child_process');
const caminho = require('node:path');
const { criarBancoTemporario } = require('../../database/banco-temporario');
const { instalarReferencia } = require('../../database/exportar-sql');
const { carregarDemonstracaoOpcional } = require('../../database/carregar-demonstracao');
const { criarPlano } = require('../../database/demonstracao/plano');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { resumoCiclo, livrosMinimoCiclos, leitoresSemParticipacao } = require('../../repositorios/relatorios');

const senhas = Object.fromEntries(['INICIO', 'METADE', 'FINAL', 'SEM_PARTICIPACAO', 'PENDENTE'].map((nome) => [`DEMO_SENHA_${nome}`, `  Senha demo de teste ${nome}  `]));
const tabelas = ['inscricoes_encontro', 'participacoes_leitura', 'encontros', 'ciclos_leitura', 'livros', 'usuarios', 'cargas_demonstracao'];

describe('Demonstração opcional, transacional e idempotente em banco próprio', { timeout: 90_000 }, () => {
  let temporario; let conexao; let ambiente;
  before(async () => {
    temporario = await criarBancoTemporario('demonstracao'); conexao = temporario.conexao;
    await instalarReferencia(temporario.variaveis); ambiente = { ...temporario.variaveis, ...senhas, DEMO_DATA_BASE: '2026-11-03' };
  });
  beforeEach(async () => {
    validarDestinoTeste(conexao, temporario.variaveis);
    await conexao.query(`TRUNCATE ${tabelas.map((tabela) => `"${tabela}"`).join(',')} RESTART IDENTITY`);
  });
  after(async () => { if (temporario) await temporario.encerrar(); });
  async function manifesto() { const [linhas] = await conexao.query('SELECT * FROM cargas_demonstracao'); return linhas[0]; }
  async function estado() {
    const resultado = {};
    for (const tabela of [...tabelas, 'generos']) {
      const [linhas] = await conexao.query(`SELECT * FROM "${tabela}" ORDER BY ${tabela === 'cargas_demonstracao' ? 'chave' : 'id'}`); resultado[tabela] = linhas;
    }
    return resultado;
  }

  it('cria cinco leitores sem admin, ciclos/encontros coerentes, referências reutilizadas, HAVING e indicadores 0/50/100', async () => {
    assert.deepEqual(await carregarDemonstracaoOpcional(ambiente, conexao), { criada: true, dataBase: '2026-11-03' });
    const controle = await manifesto(); const { ids } = controle.manifesto;
    const usuarios = await conexao.models.Usuario.scope('credenciais').findAll({ order: [['id', 'ASC']] });
    assert.equal(usuarios.length, 5); assert.equal(usuarios.filter((usuario) => usuario.situacao === 'ATIVO').length, 4);
    assert.ok(usuarios.every((usuario) => usuario.perfil === 'LEITOR' && usuario.sessionVersion === 0));
    for (const [papel, senha] of Object.entries({ inicio: senhas.DEMO_SENHA_INICIO, metade: senhas.DEMO_SENHA_METADE, final: senhas.DEMO_SENHA_FINAL,
      semParticipacao: senhas.DEMO_SENHA_SEM_PARTICIPACAO, pendente: senhas.DEMO_SENHA_PENDENTE })) assert.ok(await bcrypt.compare(senha, usuarios.find((usuario) => usuario.id === ids.usuarios[papel]).senhaHash));
    assert.deepEqual(await resumoCiclo(ids.ciclos.atual, conexao), { cicloId: ids.ciclos.atual, nome: '[Demo Leia+] Leitura atual', livroId: ids.livros.principal, participantes: 3, conclusoes: 1, taxaConclusao: 33.33, mediaProgresso: 50 });
    assert.deepEqual((await leitoresSemParticipacao(ids.ciclos.atual, conexao)).map((usuario) => usuario.id), [ids.usuarios.semParticipacao]);
    assert.equal((await livrosMinimoCiclos(2, conexao))[0].totalCiclos, 2);
    const [fora] = await conexao.query(`SELECT e.id FROM encontros e JOIN ciclos_leitura c ON c.id = e.ciclo_id
      WHERE timezone('America/Sao_Paulo',e.inicio_em)::date NOT BETWEEN c.data_inicio AND c.data_fim`); assert.deepEqual(fora, []);
    const [invalidas] = await conexao.query(`SELECT i.id FROM inscricoes_encontro i JOIN encontros e ON e.id=i.encontro_id
      LEFT JOIN participacoes_leitura p ON p.ciclo_id=e.ciclo_id AND p.usuario_id=i.usuario_id WHERE p.id IS NULL`); assert.deepEqual(invalidas, []);
    assert.equal(await conexao.models.Genero.count(), 6);
    assert.doesNotMatch(JSON.stringify(controle), /senha|hash|pagina|concluida|inicioEm|dataInicio/);
  });

  it('reexecuta sem duplicar ou sobrescrever senha, nome, versão, progresso, datas e estados modificados', async () => {
    await carregarDemonstracaoOpcional(ambiente, conexao); const { ids } = (await manifesto()).manifesto;
    const usuario = await conexao.models.Usuario.findByPk(ids.usuarios.inicio);
    await usuario.update({ nome: 'Nome editado', senhaHash: await bcrypt.hash('Senha alterada pelo teste', 4), sessionVersion: 2 });
    await conexao.models.ParticipacaoLeitura.update({ paginaAtual: 75 }, { where: { id: ids.participacoes.inicio } });
    await conexao.models.Encontro.update({ inicioEm: new Date('2026-11-06T21:00:00Z') }, { where: { id: ids.encontros.proximo } });
    await conexao.models.CicloLeitura.update({ dataFim: '2026-11-18' }, { where: { id: ids.ciclos.atual } });
    const antes = await estado();
    const outrasSenhas = Object.fromEntries(Object.keys(senhas).map((nome) => [nome, 'Outra senha válida de teste']));
    assert.equal((await carregarDemonstracaoOpcional({ ...ambiente, ...outrasSenhas, DEMO_DATA_BASE: '' }, conexao)).criada, false);
    assert.deepEqual(await estado(), antes);
    await assert.rejects(carregarDemonstracaoOpcional({ ...ambiente, DEMO_DATA_BASE: '2026-11-04' }, conexao), { codigo: 'CONFLITO_DEMONSTRACAO' });
    assert.deepEqual(await estado(), antes);
  });

  it('recusa conta preexistente, mesmo com email/nome coincidentes, sem reivindicar nem promover identidade', async () => {
    const dados = criarPlano('2026-11-03').usuarios.inicio;
    await conexao.models.Usuario.create({ ...dados, senhaHash: await bcrypt.hash('Senha da conta preexistente', 4), perfil: 'LEITOR', sessionVersion: 3 });
    const antes = await estado(); await assert.rejects(carregarDemonstracaoOpcional(ambiente, conexao), { codigo: 'CONFLITO_DEMONSTRACAO' });
    assert.deepEqual(await estado(), antes);
  });

  it('outro ciclo ativo impede tanto primeira carga quanto reexecução, sem alterar dados', async () => {
    const genero = await conexao.models.Genero.findOne();
    const obra = await conexao.models.Livro.create({ titulo: 'Obra externa', autor: 'Autora', generoId: genero.id, totalPaginas: 100 });
    const externo = await conexao.models.CicloLeitura.create({ nome: 'Ciclo externo', livroId: obra.id, dataInicio: '2026-11-01', dataFim: '2026-11-30', situacao: 'EM_ANDAMENTO' });
    const antes = await estado(); await assert.rejects(carregarDemonstracaoOpcional(ambiente, conexao), { codigo: 'CONFLITO_DEMONSTRACAO' }); assert.deepEqual(await estado(), antes);
    await externo.update({ situacao: 'CONCLUIDO' }); await carregarDemonstracaoOpcional(ambiente, conexao);
    const { ids } = (await manifesto()).manifesto; await conexao.models.CicloLeitura.update({ situacao: 'CONCLUIDO' }, { where: { id: ids.ciclos.atual } });
    await externo.update({ situacao: 'EM_ANDAMENTO' }); const apos = await estado();
    await assert.rejects(carregarDemonstracaoOpcional(ambiente, conexao), { codigo: 'CONFLITO_DEMONSTRACAO' }); assert.deepEqual(await estado(), apos);
  });

  it('duas cargas concorrentes geram somente um manifesto e uma carga completa', async () => {
    const resultados = await Promise.all([carregarDemonstracaoOpcional(ambiente, conexao), carregarDemonstracaoOpcional(ambiente, conexao)]);
    assert.deepEqual(resultados.map((resultado) => resultado.criada).sort(), [false, true]);
    const dados = await estado(); assert.equal(dados.usuarios.length, 5); assert.equal(dados.livros.length, 2); assert.equal(dados.ciclos_leitura.length, 3);
    assert.equal(dados.encontros.length, 6); assert.equal(dados.participacoes_leitura.length, 4); assert.equal(dados.inscricoes_encontro.length, 6); assert.equal(dados.cargas_demonstracao.length, 1);
  });

  it('ausência em manifesto e falha intermediária não provocam reparo parcial nem dados incompletos', async (contexto) => {
    const original = conexao.models.Encontro.create; let inseridos = 0;
    const simulada = contexto.mock.method(conexao.models.Encontro, 'create', async function (...args) {
      if (++inseridos === 3) throw new Error('Falha de fixture'); return original.apply(this, args);
    });
    const antes = await estado();
    try { await assert.rejects(carregarDemonstracaoOpcional(ambiente, conexao), /Falha de fixture/); } finally { simulada.mock.restore(); }
    assert.deepEqual(await estado(), antes);
    await carregarDemonstracaoOpcional(ambiente, conexao); const { ids } = (await manifesto()).manifesto;
    validarDestinoTeste(conexao, temporario.variaveis);
    await conexao.models.InscricaoEncontro.destroy({ where: { id: ids.inscricoes.cancelada } });
    const apos = await estado(); await assert.rejects(carregarDemonstracaoOpcional(ambiente, conexao), { codigo: 'CONFLITO_DEMONSTRACAO' }); assert.deepEqual(await estado(), apos);
  });

  it('comando explícito cria só a demo e não imprime senhas nem executa bootstrap', async () => {
    const resultado = spawnSync(process.execPath, ['database/carregar-demonstracao.js'], {
      cwd: caminho.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 20000,
      env: { ...ambiente, ADMIN_NOME: 'Admin não solicitado', ADMIN_EMAIL: 'admin@nao.example', ADMIN_SENHA: 'Senha administrativa não utilizada' },
    });
    assert.ifError(resultado.error); assert.equal(resultado.status, 0, resultado.stderr);
    const saida = `${resultado.stdout}${resultado.stderr}`;
    for (const senha of [...Object.values(senhas), 'Senha administrativa não utilizada']) assert.ok(!saida.includes(senha));
    assert.doesNotMatch(saida, /\$2[aby]\$/); assert.equal(await conexao.models.Usuario.count(), 5);
    assert.equal(await conexao.models.Usuario.count({ where: { perfil: 'ADMIN_CLUBE' } }), 0);
  });
});
