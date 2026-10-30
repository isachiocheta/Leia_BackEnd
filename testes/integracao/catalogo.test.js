'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { QueryTypes } = require('sequelize');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { criarConexao } = require('../../database/conexao');

// O schema deve estar migrado. Nenhum dado de catálogo persiste após os testes.
validarBancoTeste(process.env);
let sequencia = 0;

describe('Gêneros e livros no PostgreSQL de teste', { timeout: 20_000 }, () => {
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

  async function rejeitarBanco(transaction, executar, codigo) {
    validarDestinoTeste(conexao);
    await assert.rejects(
      conexao.transaction({ transaction }, executar),
      (erro) => erro.original?.code === codigo,
    );
  }

  async function inserir(tabela, transaction, atributos) {
    validarDestinoTeste(conexao);
    const colunas = Object.keys(atributos);
    const [linhas] = await conexao.query(
      `INSERT INTO "${tabela}" (${colunas.map((coluna) => `"${coluna}"`).join(', ')})
       VALUES (${colunas.map((coluna, indice) => `$${indice + 1}`).join(', ')}) RETURNING *`,
      { bind: Object.values(atributos), transaction },
    );
    return linhas[0];
  }

  function auditoria() {
    return {
      criado_em: new Date('2026-10-30T12:00:00Z'),
      atualizado_em: new Date('2026-10-30T12:00:00Z'),
    };
  }

  async function inserirGenero(transaction, alteracoes = {}) {
    sequencia += 1;
    return inserir('generos', transaction, {
      nome: `Gênero de teste ${sequencia}`,
      ...auditoria(),
      ...alteracoes,
    });
  }

  async function inserirLivro(transaction, generoId, alteracoes = {}) {
    return inserir('livros', transaction, {
      titulo: 'Obra cadastrada',
      autor: 'Autora informada',
      genero_id: generoId,
      total_paginas: 120,
      ...auditoria(),
      ...alteracoes,
    });
  }

  it('persiste, consulta, atualiza e remove registros sem dependentes pelos models', async () => {
    await emTransacao(async (transaction) => {
      const { Genero, Livro } = conexao.models;
      const opcoes = { transaction };
      const genero = await Genero.create({ nome: 'Aventura do model' }, opcoes);
      const livro = await Livro.create({
        titulo: 'A primeira obra', autor: 'Autora', generoId: genero.id, totalPaginas: 180,
      }, opcoes);

      assert.ok(Number.isInteger(genero.id) && genero.id > 0);
      assert.ok(Number.isInteger(livro.id) && livro.id > 0);
      const persistido = await Livro.findByPk(livro.id, opcoes);
      assert.equal(persistido.autor, 'Autora');
      assert.equal(persistido.generoId, genero.id);
      assert.equal(persistido.totalPaginas, 180);
      assert.ok(persistido.criadoEm instanceof Date);
      assert.ok(persistido.atualizadoEm instanceof Date);
      assert.equal(persistido.criado_em, undefined);
      assert.equal(persistido.autorInformado, undefined);

      await livro.update({ titulo: 'A obra revisada', totalPaginas: 200 }, opcoes);
      await genero.update({ nome: 'Aventura revisada' }, opcoes);
      assert.equal((await Livro.findByPk(livro.id, opcoes)).titulo, 'A obra revisada');
      assert.equal((await Livro.findByPk(livro.id, opcoes)).totalPaginas, 200);
      assert.equal((await Genero.findByPk(genero.id, opcoes)).nome, 'Aventura revisada');

      validarDestinoTeste(conexao);
      await livro.destroy(opcoes);
      await genero.destroy(opcoes);
      assert.equal(await Livro.findByPk(livro.id, opcoes), null);
      assert.equal(await Genero.findByPk(genero.id, opcoes), null);
    });
  });

  it('carrega as associações com aliases explícitos e uma única coluna de gênero', async () => {
    await emTransacao(async (transaction) => {
      const { Genero, Livro } = conexao.models;
      const genero = await Genero.create({ nome: 'Fantasia associada' }, { transaction });
      const primeiro = await Livro.create({ titulo: 'Uma obra', autor: 'Autor', generoId: genero.id, totalPaginas: 100 }, { transaction });
      const segundo = await Livro.create({ titulo: 'Outra obra', autor: 'Autora', generoId: genero.id, totalPaginas: 140 }, { transaction });

      const comLivros = await Genero.findByPk(genero.id, { include: ['livros'], transaction });
      assert.deepEqual(comLivros.livros.map((livro) => livro.id).sort((a, b) => a - b), [primeiro.id, segundo.id]);
      const comGenero = await Livro.findByPk(primeiro.id, { include: ['genero'], transaction });
      assert.equal(comGenero.genero.id, genero.id);
      assert.equal(comGenero.genero.nome, genero.nome);

      const atributosGenero = Object.entries(Livro.rawAttributes).filter(([, atributo]) => atributo.field === 'genero_id');
      assert.deepEqual(atributosGenero.map(([nome]) => nome), ['generoId']);
      const colunas = await conexao.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'livros' ORDER BY column_name
      `, { type: QueryTypes.SELECT, transaction });
      assert.deepEqual(colunas.map((coluna) => coluna.column_name), [
        'ano_publicacao', 'atualizado_em', 'autor', 'capa_url', 'criado_em',
        'descricao', 'genero_id', 'id', 'titulo', 'total_paginas',
      ]);
    });
  });

  it('permite campos opcionais omitidos, nulos e preenchidos', async () => {
    await emTransacao(async (transaction) => {
      const { Genero, Livro } = conexao.models;
      const genero = await Genero.create({ nome: 'Campos opcionais' }, { transaction });
      const obrigatorios = { titulo: 'Obra', autor: 'Autor', generoId: genero.id, totalPaginas: 80 };
      const omitidos = await Livro.create(obrigatorios, { transaction });
      const nulos = await Livro.create({ ...obrigatorios, anoPublicacao: null, descricao: null, capaUrl: null }, { transaction });
      const preenchidos = await Livro.create({
        ...obrigatorios, anoPublicacao: 2020, descricao: 'Uma descrição da obra.', capaUrl: 'https://escola.example/capa.jpg',
      }, { transaction });

      for (const livro of [omitidos, nulos]) {
        const registro = await Livro.findByPk(livro.id, { transaction });
        assert.equal(registro.anoPublicacao, null);
        assert.equal(registro.descricao, null);
        assert.equal(registro.capaUrl, null);
      }
      const registro = await Livro.findByPk(preenchidos.id, { transaction });
      assert.equal(registro.anoPublicacao, 2020);
      assert.equal(registro.descricao, 'Uma descrição da obra.');
      assert.equal(registro.capaUrl, 'https://escola.example/capa.jpg');
    });
  });

  it('impõe unicidade, obrigatoriedade, nome não vazio e limite de 60 no gênero', async () => {
    await emTransacao(async (transaction) => {
      const genero = await inserirGenero(transaction, { nome: 'g'.repeat(60) });
      assert.equal(genero.nome.length, 60);
      await rejeitarBanco(transaction,
        (salvamento) => inserirGenero(salvamento, { nome: genero.nome }), '23505');
      await rejeitarBanco(transaction,
        (salvamento) => inserirGenero(salvamento, { nome: null }), '23502');
      for (const nome of ['', '   ', '\t \n']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirGenero(salvamento, { nome }), '23514');
      }
      await rejeitarBanco(transaction,
        (salvamento) => inserirGenero(salvamento, { nome: 'g'.repeat(61) }), '22001');
    });
  });

  it('impõe os campos obrigatórios de livro e não inventa um total de páginas', async () => {
    await emTransacao(async (transaction) => {
      const genero = await inserirGenero(transaction);
      for (const coluna of ['id', 'titulo', 'autor', 'genero_id', 'total_paginas', 'criado_em', 'atualizado_em']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirLivro(salvamento, genero.id, { [coluna]: null }), '23502');
      }
      const [paginas] = await conexao.query(`
        SELECT column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'livros' AND column_name = 'total_paginas'
      `, { type: QueryTypes.SELECT, transaction });
      assert.equal(paginas.column_default, null);
    });
  });

  it('rejeita título e autor vazios ou só com espaços em SQL direto', async () => {
    await emTransacao(async (transaction) => {
      const genero = await inserirGenero(transaction);
      for (const coluna of ['titulo', 'autor']) {
        for (const texto of ['', '   ', '\t \n']) {
          await rejeitarBanco(transaction,
            (salvamento) => inserirLivro(salvamento, genero.id, { [coluna]: texto }), '23514');
        }
      }
    });
  });

  it('preserva os limites de título, autor e descrição no PostgreSQL', async () => {
    await emTransacao(async (transaction) => {
      const genero = await inserirGenero(transaction);
      const livro = await inserirLivro(transaction, genero.id, {
        titulo: 't'.repeat(160), autor: 'a'.repeat(120), descricao: 'd'.repeat(2000),
      });
      assert.equal(livro.titulo.length, 160);
      assert.equal(livro.autor.length, 120);
      assert.equal(livro.descricao.length, 2000);
      for (const [coluna, tamanho] of [['titulo', 161], ['autor', 121], ['descricao', 2001]]) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirLivro(salvamento, genero.id, { [coluna]: 'x'.repeat(tamanho) }), '22001');
      }
    });
  });

  it('aceita páginas positivas e rejeita zero, negativo, nulo e fracionário', async () => {
    await emTransacao(async (transaction) => {
      const genero = await inserirGenero(transaction);
      for (const total_paginas of [1, 500]) {
        assert.equal((await inserirLivro(transaction, genero.id, { total_paginas })).total_paginas, total_paginas);
      }
      for (const total_paginas of [0, -1]) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirLivro(salvamento, genero.id, { total_paginas }), '23514');
      }
      await rejeitarBanco(transaction,
        (salvamento) => inserirLivro(salvamento, genero.id, { total_paginas: null }), '23502');
      await rejeitarBanco(transaction,
        (salvamento) => inserirLivro(salvamento, genero.id, { total_paginas: 1.5 }), '22P02');
    });
  });

  it('exige ano positivo quando informado e deixa o limite superior para o serviço', async () => {
    await emTransacao(async (transaction) => {
      const genero = await inserirGenero(transaction);
      const futuro = new Date().getFullYear() + 40;
      for (const ano_publicacao of [null, 1, futuro]) {
        assert.equal((await inserirLivro(transaction, genero.id, { ano_publicacao })).ano_publicacao, ano_publicacao);
      }
      for (const ano_publicacao of [0, -10]) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirLivro(salvamento, genero.id, { ano_publicacao }), '23514');
      }
      await rejeitarBanco(transaction,
        (salvamento) => inserirLivro(salvamento, genero.id, { ano_publicacao: 2020.5 }), '22P02');

      const livro = await conexao.models.Livro.create({
        titulo: 'Publicação futura', autor: 'Autor', generoId: genero.id, totalPaginas: 100, anoPublicacao: futuro,
      }, { transaction });
      assert.equal(livro.anoPublicacao, futuro);
    });
  });

  it('rejeita gênero inexistente na persistência do livro', async () => {
    await emTransacao(async (transaction) => {
      await rejeitarBanco(transaction,
        (salvamento) => inserirLivro(salvamento, 2147483647), '23503');
    });
  });

  it('restringe a exclusão de gênero utilizado e mantém ambos os registros', async () => {
    await emTransacao(async (transaction) => {
      const { Genero, Livro } = conexao.models;
      const genero = await Genero.create({ nome: 'Gênero referenciado' }, { transaction });
      const livro = await Livro.create({ titulo: 'Obra dependente', autor: 'Autor', generoId: genero.id, totalPaginas: 90 }, { transaction });
      await rejeitarBanco(transaction,
        (salvamento) => Genero.destroy({ where: { id: genero.id }, transaction: salvamento }), '23503');
      assert.ok(await Genero.findByPk(genero.id, { transaction }));
      assert.equal((await Livro.findByPk(livro.id, { transaction })).generoId, genero.id);

      const restricoes = await conexao.query(`
        SELECT c.confdeltype FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
         WHERE c.conrelid = 'public.livros'::regclass AND c.contype = 'f' AND a.attname = 'genero_id'
      `, { type: QueryTypes.SELECT, transaction });
      assert.deepEqual(restricoes, [{ confdeltype: 'r' }]);
    });
  });

  it('permite usar uma obra cadastrada em dois ciclos sem duplicar o livro', async () => {
    await emTransacao(async (transaction) => {
      const { Genero, Livro, CicloLeitura } = conexao.models;
      const opcoes = { transaction };
      const genero = await Genero.create({ nome: 'Obra e ciclos' }, opcoes);
      const livro = await Livro.create({ titulo: 'Uma única obra', autor: 'Autora', generoId: genero.id, totalPaginas: 250 }, opcoes);
      const primeiro = await CicloLeitura.create({ livroId: livro.id, dataInicio: '2026-01-01', dataFim: '2026-01-31' }, opcoes);
      const segundo = await CicloLeitura.create({ livroId: livro.id, dataInicio: '2026-06-01', dataFim: '2026-06-30' }, opcoes);
      const comCiclos = await Livro.findByPk(livro.id, { include: ['ciclosLeitura'], transaction });

      assert.equal(primeiro.livroId, segundo.livroId);
      assert.equal(await Livro.count({ where: { id: livro.id }, transaction }), 1);
      assert.deepEqual(comCiclos.ciclosLeitura.map((ciclo) => ciclo.id).sort((a, b) => a - b), [primeiro.id, segundo.id]);
    });
  });
});
