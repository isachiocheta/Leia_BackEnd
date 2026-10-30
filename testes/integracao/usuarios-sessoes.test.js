'use strict';

const assert = require('node:assert/strict');
const { scryptSync } = require('node:crypto');
const { after, before, describe, it } = require('node:test');
const { QueryTypes } = require('sequelize');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { criarConexao } = require('../../database/conexao');

// Integração pós-migrations: não altera o schema e reverte todos os dados.
// O único valor inserido em senha_hash é uma derivação criptográfica de teste.
validarBancoTeste(process.env);
const sal = 'leia-mais-integracao-etapa03';
const senhaHash = `scrypt$${sal}$${scryptSync('entrada de teste', sal, 32).toString('hex')}`;
let sequencia = 0;

describe('Usuários e sessões no PostgreSQL de teste', { timeout: 20_000 }, () => {
  let conexao;

  before(async () => {
    conexao = criarConexao();
    validarDestinoTeste(conexao);
    await conexao.authenticate();
  });

  after(async () => {
    if (conexao) await conexao.close();
  });

  async function emTransacao(executar) {
    validarDestinoTeste(conexao);
    const transaction = await conexao.transaction();

    try {
      await executar(transaction);
    } finally {
      if (!transaction.finished) {
        validarDestinoTeste(conexao);
        await transaction.rollback();
      }
    }
  }

  function atributosUsuario(alteracoes = {}) {
    sequencia += 1;
    return {
      nome: 'Leitor de integração',
      email: `leitor-${sequencia}@escola.example`,
      senha_hash: senhaHash,
      criado_em: new Date('2026-10-30T12:00:00Z'),
      atualizado_em: new Date('2026-10-30T12:00:00Z'),
      ...alteracoes,
    };
  }

  async function inserirUsuario(transaction, alteracoes = {}) {
    validarDestinoTeste(conexao);
    const atributos = atributosUsuario(alteracoes);
    const colunas = Object.keys(atributos);
    const [linhas] = await conexao.query(
      `INSERT INTO usuarios (${colunas.map((coluna) => `"${coluna}"`).join(', ')})
       VALUES (${colunas.map((coluna, indice) => `$${indice + 1}`).join(', ')}) RETURNING *`,
      { bind: Object.values(atributos), transaction },
    );
    return linhas[0];
  }

  async function rejeitarBanco(transaction, executar, codigo) {
    validarDestinoTeste(conexao);
    await assert.rejects(
      conexao.transaction({ transaction }, executar),
      (erro) => erro.original?.code === codigo,
    );
  }

  it('gera IDs inteiros e aplica apenas os padrões não privilegiados', async () => {
    await emTransacao(async (transaction) => {
      const primeiro = await inserirUsuario(transaction);
      const segundo = await inserirUsuario(transaction);

      assert.ok(Number.isInteger(primeiro.id));
      assert.ok(primeiro.id > 0);
      assert.ok(segundo.id > primeiro.id);
      assert.equal(primeiro.perfil, 'LEITOR');
      assert.equal(primeiro.situacao, 'PENDENTE');
      assert.equal(primeiro.session_version, 0);
    });
  });

  it('impõe NOT NULL em todos os campos obrigatórios, inclusive nos padrões', async () => {
    await emTransacao(async (transaction) => {
      for (const coluna of [
        'id', 'nome', 'email', 'senha_hash', 'perfil', 'situacao',
        'session_version', 'criado_em', 'atualizado_em',
      ]) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirUsuario(salvamento, { [coluna]: null }), '23502');
      }
    });
  });

  it('rejeita nome vazio ou só com espaços e preserva os limites de nome e email', async () => {
    await emTransacao(async (transaction) => {
      for (const nome of ['', '   ', '\t \n']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirUsuario(salvamento, { nome }), '23514');
      }

      const emailLimite = `${'a'.repeat(244)}@x.example`;
      assert.equal(emailLimite.length, 254);
      const usuario = await inserirUsuario(transaction, { nome: 'n'.repeat(100), email: emailLimite });
      assert.equal(usuario.nome.length, 100);
      assert.equal(usuario.email.length, 254);
      await rejeitarBanco(transaction,
        (salvamento) => inserirUsuario(salvamento, { nome: 'n'.repeat(101) }), '22001');
      await rejeitarBanco(transaction,
        (salvamento) => inserirUsuario(salvamento, { email: `a${emailLimite}` }), '22001');
    });
  });

  it('protege a normalização e unicidade de email também em SQL direto', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await inserirUsuario(transaction);

      await rejeitarBanco(transaction,
        (salvamento) => inserirUsuario(salvamento, { email: usuario.email }), '23505');

      for (const email of ['', ' ', 'Leitor@escola.example', ' leitor@escola.example ']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirUsuario(salvamento, { email }), '23514');
      }
    });
  });

  it('rejeita hashes ausentes ou vazios sem inventar senha padrão', async () => {
    await emTransacao(async (transaction) => {
      await rejeitarBanco(transaction,
        (salvamento) => inserirUsuario(salvamento, { senha_hash: null }), '23502');
      for (const hash of ['', '   ']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirUsuario(salvamento, { senha_hash: hash }), '23514');
      }

      const [coluna] = await conexao.query(`
        SELECT column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'usuarios' AND column_name = 'senha_hash'
      `, { type: QueryTypes.SELECT, transaction });
      assert.equal(coluna.column_default, null);
    });
  });

  it('usa VARCHAR e CHECK para perfil e situação, aceitando somente os valores permitidos', async () => {
    await emTransacao(async (transaction) => {
      for (const perfil of ['ADMIN_CLUBE', 'LEITOR']) {
        for (const situacao of ['PENDENTE', 'ATIVO', 'INATIVO']) {
          const usuario = await inserirUsuario(transaction, { perfil, situacao });
          assert.equal(usuario.perfil, perfil);
          assert.equal(usuario.situacao, situacao);
        }
      }

      for (const perfil of ['ADMIN', 'admin_clube', '']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirUsuario(salvamento, { perfil }), '23514');
      }
      for (const situacao of ['APROVADO', 'ativo', '']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirUsuario(salvamento, { situacao }), '23514');
      }

      const colunas = await conexao.query(`
        SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'usuarios'
           AND column_name IN ('perfil', 'situacao') ORDER BY column_name
      `, { type: QueryTypes.SELECT, transaction });
      assert.deepEqual(colunas, [
        { column_name: 'perfil', data_type: 'character varying' },
        { column_name: 'situacao', data_type: 'character varying' },
      ]);
    });
  });

  it('aceita session_version zero e positivo, rejeitando negativo e fracionário', async () => {
    await emTransacao(async (transaction) => {
      for (const session_version of [0, 1, 2147483647]) {
        const usuario = await inserirUsuario(transaction, { session_version });
        assert.equal(usuario.session_version, session_version);
      }

      await rejeitarBanco(transaction,
        (salvamento) => inserirUsuario(salvamento, { session_version: -1 }), '23514');
      await rejeitarBanco(transaction,
        (salvamento) => inserirUsuario(salvamento, { session_version: 0.5 }), '22P02');
    });
  });

  it('normaliza email no model e mantém consultas públicas sem senhaHash', async () => {
    await emTransacao(async (transaction) => {
      const { Usuario } = conexao.models;
      const usuario = await Usuario.create({
        nome: 'Leitor do model', email: '  LeItOr.Model@Escola.Example  ', senhaHash,
      }, { transaction });

      assert.equal(usuario.email, 'leitor.model@escola.example');
      const publico = await Usuario.findByPk(usuario.id, { transaction });
      assert.equal(publico.senhaHash, undefined);
      assert.equal(Object.hasOwn(publico.toJSON(), 'senhaHash'), false);
      assert.equal(publico.sessionVersion, 0);
      assert.ok(publico.criadoEm instanceof Date);
      assert.ok(publico.atualizadoEm instanceof Date);
      assert.equal(publico.criado_em, undefined);
      assert.equal(publico.atualizado_em, undefined);

      const credenciais = await Usuario.scope('credenciais').findOne({
        where: { email: usuario.email }, transaction,
      });
      assert.equal(credenciais.senhaHash, senhaHash);

      await assert.rejects(Usuario.create({
        nome: 'Email repetido', email: 'LEITOR.MODEL@ESCOLA.EXAMPLE', senhaHash,
      }, { transaction }), { name: 'SequelizeUniqueConstraintError' });
    });
  });

  it('preserva a exclusão de senhaHash ao incluir usuário por associação', async () => {
    await emTransacao(async (transaction) => {
      const { Usuario, Genero, Livro, CicloLeitura, ParticipacaoLeitura } = conexao.models;
      const opcoes = { transaction };
      const usuario = await Usuario.create({ nome: 'Participante', email: 'associacao@escola.example', senhaHash }, opcoes);
      const genero = await Genero.create({ nome: 'Gênero de integração' }, opcoes);
      const livro = await Livro.create({ titulo: 'Livro', autor: 'Autor', generoId: genero.id, totalPaginas: 100 }, opcoes);
      const ciclo = await CicloLeitura.create({ nome: 'Ciclo de participação', livroId: livro.id, dataInicio: '2026-10-01', dataFim: '2026-10-31' }, opcoes);
      const participacao = await ParticipacaoLeitura.create({ usuarioId: usuario.id, cicloLeituraId: ciclo.id }, opcoes);
      const resultado = await ParticipacaoLeitura.findByPk(participacao.id, { include: ['usuario'], transaction });

      assert.equal(resultado.usuario.id, usuario.id);
      assert.equal(Object.hasOwn(resultado.usuario.toJSON(), 'senhaHash'), false);
    });
  });

  it('mantém exatamente a estrutura técnica esperada por connect-pg-simple', async () => {
    const colunas = await conexao.query(`
      SELECT column_name, data_type, is_nullable, character_maximum_length, datetime_precision
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sessoes' ORDER BY ordinal_position
    `, { type: QueryTypes.SELECT });

    assert.deepEqual(colunas, [
      { column_name: 'sid', data_type: 'character varying', is_nullable: 'NO', character_maximum_length: null, datetime_precision: null },
      { column_name: 'sess', data_type: 'json', is_nullable: 'NO', character_maximum_length: null, datetime_precision: null },
      { column_name: 'expire', data_type: 'timestamp without time zone', is_nullable: 'NO', character_maximum_length: null, datetime_precision: 6 },
    ]);

    const chaves = await conexao.query(`
      SELECT a.attname AS coluna
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.conrelid = 'public.sessoes'::regclass AND c.contype = 'p'
    `, { type: QueryTypes.SELECT });
    assert.deepEqual(chaves, [{ coluna: 'sid' }]);

    const indices = await conexao.query(`
      SELECT indexdef FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND tablename = 'sessoes'
    `, { type: QueryTypes.SELECT });
    assert.ok(indices.some((indice) => /\(expire\)/.test(indice.indexdef)));
  });

  it('permite set, atualização por sid, leitura, touch e destruição de sessão', async () => {
    await emTransacao(async (transaction) => {
      const sid = `sessao-${'s'.repeat(300)}`;
      const sessao = { cookie: { expires: '2026-11-01T12:00:00.000Z' }, leia: { usuarioId: 7 } };
      const sqlSet = `INSERT INTO sessoes (sid, sess, expire) VALUES ($1, $2::json, $3::timestamp)
                     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`;
      await conexao.query(sqlSet, { bind: [sid, JSON.stringify(sessao), '2026-11-01 12:00:00.123456'], transaction });
      const [primeira] = await conexao.query('SELECT sess, expire::text AS expire FROM sessoes WHERE sid = $1', {
        bind: [sid], type: QueryTypes.SELECT, transaction,
      });
      assert.deepEqual(primeira.sess, sessao);
      assert.equal(primeira.expire, '2026-11-01 12:00:00.123456');

      const atualizada = { ...sessao, leia: { usuarioId: 8 } };
      await conexao.query(sqlSet, { bind: [sid, JSON.stringify(atualizada), '2026-11-02 12:00:00'], transaction });
      await conexao.query('UPDATE sessoes SET expire = $1::timestamp WHERE sid = $2', {
        bind: ['2026-11-03 12:00:00.654321', sid], transaction,
      });
      const [aposTouch] = await conexao.query('SELECT sess, expire::text AS expire FROM sessoes WHERE sid = $1', {
        bind: [sid], type: QueryTypes.SELECT, transaction,
      });
      assert.deepEqual(aposTouch.sess, atualizada);
      assert.equal(aposTouch.expire, '2026-11-03 12:00:00.654321');

      validarDestinoTeste(conexao);
      await conexao.query('DELETE FROM sessoes WHERE sid = $1', { bind: [sid], transaction });
      const restantes = await conexao.query('SELECT sid FROM sessoes WHERE sid = $1', {
        bind: [sid], type: QueryTypes.SELECT, transaction,
      });
      assert.deepEqual(restantes, []);
    });
  });

  it('impõe PK e obrigatoriedade dos três campos técnicos da sessão', async () => {
    await emTransacao(async (transaction) => {
      const base = ['sessao-obrigatoria', JSON.stringify({ cookie: {} }), '2026-11-01 12:00:00'];
      const inserir = (salvamento, valores) => conexao.query(
        'INSERT INTO sessoes (sid, sess, expire) VALUES ($1, $2::json, $3::timestamp)',
        { bind: valores, transaction: salvamento },
      );

      await inserir(transaction, base);
      await rejeitarBanco(transaction, (salvamento) => inserir(salvamento, base), '23505');
      for (let indice = 0; indice < 3; indice += 1) {
        const valores = ['outra-sessao', base[1], base[2]];
        valores[indice] = null;
        await rejeitarBanco(transaction, (salvamento) => inserir(salvamento, valores), '23502');
      }
      await rejeitarBanco(transaction,
        (salvamento) => inserir(salvamento, ['json-invalido', '{invalido', base[2]]), '22P02');
    });
  });
});
