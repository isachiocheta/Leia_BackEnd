'use strict';

const assert = require('node:assert/strict');
const caminho = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');
const bcrypt = require('bcrypt');
const { criarConexao } = require('../../database/conexao');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { bootstrapAdministrativo } = require('../../database/bootstrap-administrativo');
const referencia = require('../../database/semeadores/referencias/20261030061000-carregar-generos-referencia');

validarBancoTeste(process.env);
const diretorioBackend = caminho.resolve(__dirname, '../..');
const nomeSeeder = '20261030061000-carregar-generos-referencia.js';
const tabelasDominio = [
  'usuarios', 'generos', 'livros', 'ciclos_leitura', 'encontros',
  'participacoes_leitura', 'inscricoes_encontro',
];
let conexao;

function executar(arquivo, argumentos = [], variaveis = {}, codigo = 0) {
  validarDestinoTeste(conexao);
  const ambiente = { ...process.env };
  for (const nome of ['ADMIN_NOME', 'ADMIN_EMAIL', 'ADMIN_SENHA']) delete ambiente[nome];
  const resultado = spawnSync(process.execPath, [caminho.join(diretorioBackend, arquivo), ...argumentos], {
    cwd: diretorioBackend, env: { ...ambiente, ...variaveis },
    encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL',
  });
  assert.ifError(resultado.error);
  assert.equal(resultado.signal, null, resultado.stderr);
  assert.equal(resultado.status, codigo, `${resultado.stdout}\n${resultado.stderr}`);
  return `${resultado.stdout}${resultado.stderr}`;
}

function carregarReferencias() {
  executar('database/executar-cli.js', ['db:seed:all']);
}

function reverterReferencias(codigo = 0) {
  executar('database/executar-cli.js', ['db:seed:undo', '--seed', nomeSeeder], {}, codigo);
}

async function consultar(sql, bind = []) {
  const [linhas] = await conexao.query(sql, { bind });
  return linhas;
}

before(async () => {
  conexao = criarConexao();
  validarDestinoTeste(conexao);
  await conexao.authenticate();
  // Estes testes precisam observar commits do CLI e concorrência real. Recusam
  // dados existentes antes de criar suas fixtures e as removem em finally.
  for (const tabela of [...tabelasDominio, 'generos_semeados', 'sequelize_seeds']) {
    assert.deepEqual(await consultar(`SELECT 1 FROM "${tabela}" LIMIT 1`), [], 'Use um banco isolado, migrado e sem dados.');
  }
});

after(async () => {
  if (conexao) await conexao.close();
});

test('CLI registra o histórico, repete referências sem duplicar e reverte só sua autoria', { timeout: 45_000 }, async () => {
  const { Genero, Livro } = conexao.models;
  const originais = [];
  let livro;
  try {
    validarDestinoTeste(conexao);
    for (const nome of ['Aventura', 'Categoria local']) {
      originais.push(await Genero.create({
        nome, criadoEm: new Date('2001-01-01T12:00:00Z'), atualizadoEm: new Date('2001-01-02T12:00:00Z'),
      }));
    }
    const antes = originais.map((genero) => genero.toJSON());
    carregarReferencias();
    const primeiraCarga = await consultar('SELECT * FROM generos ORDER BY id');
    assert.equal(primeiraCarga.length, 7);
    assert.deepEqual(await consultar('SELECT name FROM sequelize_seeds'), [{ name: nomeSeeder }]);
    assert.equal((await consultar('SELECT * FROM generos_semeados')).length, 5);
    for (const tabela of tabelasDominio.filter((nome) => nome !== 'generos')) {
      assert.deepEqual(await consultar(`SELECT 1 FROM "${tabela}" LIMIT 1`), []);
    }

    carregarReferencias();
    assert.deepEqual(await consultar('SELECT * FROM generos ORDER BY id'), primeiraCarga);
    assert.deepEqual(await consultar('SELECT name FROM sequelize_seeds'), [{ name: nomeSeeder }]);
    assert.equal((await consultar('SELECT * FROM generos_semeados')).length, 5);

    const generoUsado = await Genero.findOne({ where: { nome: 'Romance' } });
    validarDestinoTeste(conexao);
    livro = await Livro.create({ titulo: 'Fixture de proteção da referência', autor: 'Autora', generoId: generoUsado.id, totalPaginas: 10 });
    reverterReferencias(1);
    assert.deepEqual(await consultar('SELECT * FROM generos ORDER BY id'), primeiraCarga);
    assert.deepEqual(await consultar('SELECT name FROM sequelize_seeds'), [{ name: nomeSeeder }]);
    assert.equal((await consultar('SELECT * FROM generos_semeados')).length, 5);

    validarDestinoTeste(conexao);
    await livro.destroy();
    livro = undefined;
    reverterReferencias();
    reverterReferencias();
    assert.equal(await Genero.count(), 2);
    for (let indice = 0; indice < originais.length; indice += 1) {
      assert.deepEqual((await Genero.findByPk(originais[indice].id)).toJSON(), antes[indice]);
    }
    assert.deepEqual(await consultar('SELECT * FROM generos_semeados'), []);
    assert.deepEqual(await consultar('SELECT name FROM sequelize_seeds'), []);
  } finally {
    validarDestinoTeste(conexao);
    if (livro) await livro.destroy();
    await referencia.down(conexao.getQueryInterface());
    await conexao.query('DELETE FROM sequelize_seeds WHERE name = $1', { bind: [nomeSeeder] });
    for (const genero of originais) await Genero.destroy({ where: { id: genero.id } });
  }
});

test('bootstrap concorrente e CLI preservam credenciais e recusam promoção de leitor', { timeout: 30_000 }, async () => {
  const { Usuario } = conexao.models;
  const ambiente = {
    ADMIN_NOME: 'Administradora da carga', ADMIN_EMAIL: '  ADMIN.CARGA@ESCOLA.EXEMPLO  ',
    ADMIN_SENHA: '  senha de teste com espaços  ',
  };
  const ids = [];
  try {
    validarDestinoTeste(conexao);
    executar('database/bootstrap-administrativo.js', [], { ADMIN_NOME: ambiente.ADMIN_NOME, ADMIN_EMAIL: ambiente.ADMIN_EMAIL }, 1);
    assert.equal(await Usuario.count(), 0);

    const resultados = await Promise.all([
      bootstrapAdministrativo(ambiente, conexao), bootstrapAdministrativo(ambiente, conexao),
    ]);
    assert.equal(resultados.filter((resultado) => resultado.criado).length, 1);
    assert.equal(await Usuario.count(), 1);
    const usuario = await Usuario.scope('credenciais').findOne({ where: { email: 'admin.carga@escola.exemplo' } });
    ids.push(usuario.id);
    assert.equal(usuario.perfil, 'ADMIN_CLUBE');
    assert.equal(usuario.situacao, 'ATIVO');
    assert.equal(usuario.sessionVersion, 0);
    assert.equal(bcrypt.getRounds(usuario.senhaHash), 12);
    assert.equal(await bcrypt.compare(ambiente.ADMIN_SENHA, usuario.senhaHash), true);
    assert.equal(await bcrypt.compare(ambiente.ADMIN_SENHA.trim(), usuario.senhaHash), false);

    await usuario.update({ sessionVersion: 5 });
    const antes = usuario.toJSON();
    const saida = executar('database/bootstrap-administrativo.js', [], { ...ambiente, ADMIN_SENHA: 'outra senha de teste válida' });
    assert.ok(!saida.includes(ambiente.ADMIN_SENHA));
    assert.ok(!saida.includes(usuario.senhaHash));
    const depois = await Usuario.scope('credenciais').findByPk(usuario.id);
    assert.deepEqual(depois.toJSON(), antes);

    const leitor = await Usuario.create({
      nome: 'Leitor da carga', email: 'leitor.carga@escola.exemplo', senhaHash: usuario.senhaHash,
      perfil: 'LEITOR', situacao: 'ATIVO', sessionVersion: 3,
    });
    ids.push(leitor.id);
    executar('database/bootstrap-administrativo.js', [], {
      ...ambiente, ADMIN_NOME: leitor.nome, ADMIN_EMAIL: leitor.email,
    }, 1);
    const preservado = await Usuario.scope('credenciais').findByPk(leitor.id);
    assert.equal(preservado.perfil, 'LEITOR');
    assert.equal(preservado.senhaHash, usuario.senhaHash);
    assert.equal(preservado.sessionVersion, 3);
  } finally {
    validarDestinoTeste(conexao);
    for (const id of ids) await Usuario.destroy({ where: { id } });
  }
});
