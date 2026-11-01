'use strict';

const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { after, before, describe, it } = require('node:test');
const { QueryTypes, Transaction } = require('sequelize');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { criarConexao } = require('../../database/conexao');
const { bootstrapAdministrativo } = require('../../database/bootstrap-administrativo');
const referencias = require('../../database/semeadores/referencias/20261030061000-carregar-generos-referencia');

// O histórico real do CLI é verificado na suíte separada de cargas. Aqui cada
// escrita, inclusive as transações internas das rotinas, termina em rollback.
validarBancoTeste(process.env);
const semeador = '20261030061000-carregar-generos-referencia.js';
const nomesReferencia = ['Aventura', 'Conto', 'Fábula', 'Ficção científica', 'Poesia', 'Romance'];
let sequencia = 0;

describe('Referências e bootstrap no PostgreSQL de teste', { timeout: 30_000 }, () => {
  let conexao;
  let hashFixture;

  before(async () => {
    conexao = criarConexao();
    validarDestinoTeste(conexao);
    await conexao.authenticate();
    hashFixture = await bcrypt.hash('Entrada apenas da fixture', 4);
  });

  after(async () => {
    if (conexao) await conexao.close();
  });

  function conexaoNaTransacao(transaction) {
    const proxy = Object.create(conexao);
    proxy.query = conexao.query.bind(conexao);
    proxy.transaction = (executar) => conexao.transaction({ transaction }, executar);
    return proxy;
  }

  async function emTransacao(executar) {
    validarDestinoTeste(conexao);
    // Um snapshot estável distingue escritas do seeder das fixtures HTTP
    // confirmadas por outras suítes que usam o mesmo banco isolado em paralelo.
    const transaction = await conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ });
    const proxy = conexaoNaTransacao(transaction);
    const queryInterface = Object.create(conexao.getQueryInterface());
    Object.defineProperty(queryInterface, 'sequelize', { value: proxy });

    try {
      await executar({ transaction, proxy, queryInterface });
    } finally {
      if (!transaction.finished) {
        validarDestinoTeste(conexao);
        await transaction.rollback();
      }
    }
  }

  function ambienteAdministrador(alteracoes = {}) {
    sequencia += 1;
    return {
      ...process.env,
      ADMIN_NOME: 'Administrador da integração',
      ADMIN_EMAIL: `bootstrap-${sequencia}@escola.example`,
      ADMIN_SENHA: '  Acesso 🐝 da integração  ',
      ...alteracoes,
    };
  }

  async function credenciais(email, transaction) {
    return conexao.models.Usuario.scope('credenciais').findOne({
      where: { email: email.trim().toLowerCase() }, transaction,
    });
  }

  async function origem(transaction) {
    return conexao.query('SELECT genero_id FROM generos_semeados WHERE semeador = $1 ORDER BY genero_id', {
      bind: [semeador], type: QueryTypes.SELECT, transaction,
    });
  }

  async function contarModelos(nomes, transaction) {
    const contagens = [];
    for (const nome of nomes) {
      contagens.push(await conexao.models[nome].count({ transaction }));
    }
    return contagens;
  }

  async function criarPreexistente(transaction) {
    const data = new Date('2020-02-03T12:34:56.000Z');
    return conexao.models.Genero.create({ nome: 'Aventura', criadoEm: data, atualizadoEm: data }, {
      transaction, silent: true,
    });
  }

  it('carga repetida insere apenas referências, sem duplicar nem assumir dados reutilizados', async () => {
    await emTransacao(async ({ transaction, queryInterface }) => {
      const preexistente = await criarPreexistente(transaction);
      const anteriores = await conexao.models.Genero.findByPk(preexistente.id, { transaction, raw: true });
      const tabelasDominio = ['Usuario', 'Livro', 'CicloLeitura', 'Encontro', 'ParticipacaoLeitura', 'InscricaoEncontro'];
      const contagensAntes = await contarModelos(tabelasDominio, transaction);
      const totalGenerosAntes = await conexao.models.Genero.count({ transaction });

      await referencias.up(queryInterface);
      await referencias.up(queryInterface);

      const generos = await conexao.models.Genero.findAll({ where: { nome: nomesReferencia }, attributes: ['id', 'nome'], order: [['nome', 'ASC']], transaction });
      assert.equal(generos.length, nomesReferencia.length);
      assert.deepEqual(generos.map((genero) => genero.nome).sort(), [...nomesReferencia].sort());
      assert.equal(await conexao.models.Genero.count({ transaction }) - totalGenerosAntes, nomesReferencia.length - 1);
      assert.deepEqual(await conexao.models.Genero.findByPk(preexistente.id, { transaction, raw: true }), anteriores);
      const proprietarios = await origem(transaction);
      assert.equal(proprietarios.length, nomesReferencia.length - 1);
      assert.ok(proprietarios.every((linha) => linha.genero_id !== preexistente.id));
      assert.deepEqual(await contarModelos(tabelasDominio, transaction), contagensAntes);
    });
  });

  it('reversão remove somente os gêneros inseridos pelo seeder', async () => {
    await emTransacao(async ({ transaction, queryInterface }) => {
      const preexistente = await criarPreexistente(transaction);
      const outro = await conexao.models.Genero.create({ nome: `Referência alheia ${process.pid}` }, { transaction });
      await referencias.up(queryInterface);
      await referencias.down(queryInterface);
      await referencias.down(queryInterface);

      const restantes = await conexao.models.Genero.findAll({ where: { nome: nomesReferencia }, attributes: ['id', 'nome'], transaction });
      assert.deepEqual(restantes.map((genero) => genero.get()), [{ id: preexistente.id, nome: 'Aventura' }]);
      assert.ok(await conexao.models.Genero.findByPk(outro.id, { transaction }));
      assert.deepEqual(await origem(transaction), []);
    });
  });

  it('reversão de referência em uso falha atomicamente e não elimina livros', async () => {
    await emTransacao(async ({ transaction, queryInterface }) => {
      await referencias.up(queryInterface);
      const genero = await conexao.models.Genero.findOne({ where: { nome: 'Romance' }, transaction });
      const livro = await conexao.models.Livro.create({
        titulo: 'Obra da referência', autor: 'Autora', generoId: genero.id, totalPaginas: 100,
      }, { transaction });
      const autoriaAntes = await origem(transaction);

      await assert.rejects(referencias.down(queryInterface), { name: 'SequelizeForeignKeyConstraintError' });
      assert.equal(await conexao.models.Genero.count({ where: { nome: nomesReferencia }, transaction }), nomesReferencia.length);
      assert.deepEqual(await origem(transaction), autoriaAntes);
      assert.ok(await conexao.models.Livro.findByPk(livro.id, { transaction }));
    });
  });

  it('reversão exige ambiente de teste antes de remover qualquer referência', async () => {
    await emTransacao(async ({ transaction, queryInterface }) => {
      await referencias.up(queryInterface);
      const anterior = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        await assert.rejects(referencias.down(queryInterface), /NODE_ENV/);
      } finally {
        if (anterior === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = anterior;
      }
      assert.equal(await conexao.models.Genero.count({ where: { nome: nomesReferencia }, transaction }), nomesReferencia.length);
      assert.equal((await origem(transaction)).length, nomesReferencia.length);
    });
  });

  it('bootstrap cria administrador ativo com bcrypt verificável sem transformar a senha', async () => {
    await emTransacao(async ({ transaction, proxy }) => {
      const ambiente = ambienteAdministrador({ ADMIN_NOME: '  Administradora Escolar  ', ADMIN_EMAIL: '  ADMIN.ESCOLAR@ESCOLA.EXAMPLE  ' });
      const resultado = await bootstrapAdministrativo(ambiente, proxy);
      assert.deepEqual(resultado, { criado: true });
      const usuario = await credenciais(ambiente.ADMIN_EMAIL, transaction);

      assert.equal(usuario.nome, 'Administradora Escolar');
      assert.equal(usuario.email, 'admin.escolar@escola.example');
      assert.equal(usuario.perfil, 'ADMIN_CLUBE');
      assert.equal(usuario.situacao, 'ATIVO');
      assert.equal(usuario.sessionVersion, 0);
      assert.match(usuario.senhaHash, /^\$2[ab]\$12\$/);
      assert.equal(bcrypt.getRounds(usuario.senhaHash), 12);
      assert.equal(await bcrypt.compare(ambiente.ADMIN_SENHA, usuario.senhaHash), true);
      assert.equal(await bcrypt.compare(ambiente.ADMIN_SENHA.trim(), usuario.senhaHash), false);
      assert.equal(JSON.stringify(resultado).includes(usuario.senhaHash), false);
    });
  });

  it('reexecução normaliza o email e preserva hash, identidade e versão existentes', async () => {
    await emTransacao(async ({ transaction, proxy }) => {
      const ambiente = ambienteAdministrador();
      await bootstrapAdministrativo(ambiente, proxy);
      const usuario = await credenciais(ambiente.ADMIN_EMAIL, transaction);
      await usuario.update({ sessionVersion: 7 }, { transaction });
      const antes = usuario.get({ plain: true });

      assert.deepEqual(await bootstrapAdministrativo({
        ...ambiente,
        ADMIN_NOME: `  ${ambiente.ADMIN_NOME}  `,
        ADMIN_EMAIL: `  ${ambiente.ADMIN_EMAIL.toUpperCase()}  `,
        ADMIN_SENHA: 'Outra entrada válida da fixture',
      }, proxy), { criado: false });

      const depois = await credenciais(ambiente.ADMIN_EMAIL, transaction);
      assert.deepEqual(depois.get({ plain: true }), antes);
      assert.equal(await bcrypt.compare(ambiente.ADMIN_SENHA, depois.senhaHash), true);
      assert.equal(await bcrypt.compare('Outra entrada válida da fixture', depois.senhaHash), false);
      assert.equal(await conexao.models.Usuario.count({ where: { email: usuario.email }, transaction }), 1);
    });
  });

  it('email coincidente com leitor nunca autoriza promoção ou redefinição de senha', async () => {
    await emTransacao(async ({ transaction, proxy }) => {
      for (const situacao of ['PENDENTE', 'ATIVO', 'INATIVO']) {
        const ambiente = ambienteAdministrador();
        const leitor = await conexao.models.Usuario.create({
          nome: ambiente.ADMIN_NOME, email: ambiente.ADMIN_EMAIL, senhaHash: hashFixture,
          perfil: 'LEITOR', situacao, sessionVersion: 3,
        }, { transaction });
        const antes = (await credenciais(leitor.email, transaction)).get({ plain: true });

        await assert.rejects(bootstrapAdministrativo(ambiente, proxy), { codigo: 'CONFLITO_ADMINISTRADOR' });
        assert.deepEqual((await credenciais(leitor.email, transaction)).get({ plain: true }), antes);
      }
    });
  });

  it('recusa conflito de nome e administradores pendentes ou inativos sem alterá-los', async () => {
    await emTransacao(async ({ transaction, proxy }) => {
      for (const alteracoes of [
        { nome: 'Outra pessoa', situacao: 'ATIVO' },
        { situacao: 'PENDENTE' },
        { situacao: 'INATIVO' },
      ]) {
        const ambiente = ambienteAdministrador();
        const usuario = await conexao.models.Usuario.create({
          nome: ambiente.ADMIN_NOME, email: ambiente.ADMIN_EMAIL, senhaHash: hashFixture,
          perfil: 'ADMIN_CLUBE', situacao: 'ATIVO', sessionVersion: 4, ...alteracoes,
        }, { transaction });
        const antes = (await credenciais(usuario.email, transaction)).get({ plain: true });

        await assert.rejects(bootstrapAdministrativo(ambiente, proxy), { codigo: 'CONFLITO_ADMINISTRADOR' });
        assert.deepEqual((await credenciais(usuario.email, transaction)).get({ plain: true }), antes);
      }
    });
  });

  it('credenciais ausentes ou inválidas não inserem usuários nem revelam a senha', async () => {
    await emTransacao(async ({ transaction, proxy }) => {
      const ambiente = ambienteAdministrador();
      const antes = await conexao.models.Usuario.count({ transaction });
      for (const alteracoes of [
        { ADMIN_NOME: undefined }, { ADMIN_NOME: '   ' }, { ADMIN_NOME: 'n'.repeat(101) },
        { ADMIN_EMAIL: undefined }, { ADMIN_EMAIL: 'sem-arroba' },
        { ADMIN_SENHA: undefined }, { ADMIN_SENHA: '123456789' },
        { ADMIN_SENHA: 'a'.repeat(73) }, { ADMIN_SENHA: 'é'.repeat(37) },
      ]) {
        await assert.rejects(bootstrapAdministrativo({ ...ambiente, ...alteracoes }, proxy), (erro) => {
          assert.equal(erro.codigo, 'CONFIGURACAO_ADMINISTRADOR_INVALIDA');
          assert.equal(erro.message.includes(ambiente.ADMIN_SENHA), false);
          return true;
        });
      }
      assert.equal(await conexao.models.Usuario.count({ transaction }), antes);
    });
  });

  it('aceita os limites de dez caracteres e 72 bytes UTF-8 sem truncamento', async () => {
    await emTransacao(async ({ transaction, proxy }) => {
      for (const senha of ['abcdefghij', '🐝'.repeat(10), 'a'.repeat(72), 'é'.repeat(36)]) {
        const ambiente = ambienteAdministrador({ ADMIN_SENHA: senha });
        assert.deepEqual(await bootstrapAdministrativo(ambiente, proxy), { criado: true });
        const usuario = await credenciais(ambiente.ADMIN_EMAIL, transaction);
        assert.equal(await bcrypt.compare(senha, usuario.senhaHash), true);
      }
    });
  });
});
