'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { QueryTypes } = require('sequelize');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { criarConexao } = require('../../database/conexao');

// O schema já deve estar migrado. Datas civis usam strings YYYY-MM-DD;
// nenhuma fixture de ciclo converte essas datas para Date ou UTC.
validarBancoTeste(process.env);
let sequencia = 0;

describe('Ciclos de leitura no PostgreSQL de teste', { timeout: 20_000 }, () => {
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
    await assert.rejects(conexao.transaction({ transaction }, executar), (erro) => erro.original?.code === codigo);
  }

  async function criarObras(transaction) {
    validarDestinoTeste(conexao);
    const { Genero, Livro } = conexao.models;
    sequencia += 1;
    const genero = await Genero.create({ nome: `Gênero para ciclos ${sequencia}` }, { transaction });
    const dados = { titulo: 'Obra para ciclos', autor: 'Autora', generoId: genero.id, totalPaginas: 150 };
    const primeiro = await Livro.create(dados, { transaction });
    const segundo = await Livro.create({ ...dados, titulo: 'Outra obra para ciclos' }, { transaction });
    return [primeiro, segundo];
  }

  async function inserirCiclo(transaction, livroId, alteracoes = {}) {
    validarDestinoTeste(conexao);
    sequencia += 1;
    const atributos = {
      nome: `Ciclo de teste ${sequencia}`,
      livro_id: livroId,
      data_inicio: '2026-10-01',
      data_fim: '2026-10-31',
      criado_em: new Date('2026-10-30T12:00:00Z'),
      atualizado_em: new Date('2026-10-30T12:00:00Z'),
      ...alteracoes,
    };
    const colunas = Object.keys(atributos);
    const [linhas] = await conexao.query(`
      INSERT INTO ciclos_leitura (${colunas.map((coluna) => `"${coluna}"`).join(', ')})
      VALUES (${colunas.map((coluna, indice) => `$${indice + 1}`).join(', ')}) RETURNING *
    `, { bind: Object.values(atributos), transaction });
    return linhas[0];
  }

  it('permite vários ciclos planejados e concluídos para a mesma obra e outras obras', async () => {
    await emTransacao(async (transaction) => {
      const obras = await criarObras(transaction);
      for (const obra of obras) {
        for (const situacao of ['PLANEJADO', 'CONCLUIDO']) {
          await inserirCiclo(transaction, obra.id, { situacao });
          await inserirCiclo(transaction, obra.id, { situacao });
        }
      }
      const [quantidade] = await conexao.query('SELECT count(*)::integer AS total FROM ciclos_leitura', {
        type: QueryTypes.SELECT, transaction,
      });
      assert.equal(quantidade.total, 8);
    });
  });

  it('recusa por SQL direto o segundo ciclo em andamento, inclusive de outra obra', async () => {
    await emTransacao(async (transaction) => {
      const [primeira, segunda] = await criarObras(transaction);
      const ativo = await inserirCiclo(transaction, primeira.id, { situacao: 'EM_ANDAMENTO' });
      assert.equal(ativo.situacao, 'EM_ANDAMENTO');
      for (const livroId of [primeira.id, segunda.id]) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirCiclo(salvamento, livroId, { situacao: 'EM_ANDAMENTO' }), '23505');
      }
      await inserirCiclo(transaction, primeira.id, { situacao: 'PLANEJADO' });
      await inserirCiclo(transaction, segunda.id, { situacao: 'CONCLUIDO' });
      const ativos = await conexao.query("SELECT id FROM ciclos_leitura WHERE situacao = 'EM_ANDAMENTO'", {
        type: QueryTypes.SELECT, transaction,
      });
      assert.deepEqual(ativos, [{ id: ativo.id }]);
    });
  });

  it('impede ativação concorrente por UPDATE e libera a vaga ao concluir o ativo', async () => {
    await emTransacao(async (transaction) => {
      const [primeira, segunda] = await criarObras(transaction);
      const ativo = await inserirCiclo(transaction, primeira.id, { situacao: 'EM_ANDAMENTO' });
      const planejado = await inserirCiclo(transaction, segunda.id);
      await rejeitarBanco(transaction, async (salvamento) => {
        validarDestinoTeste(conexao);
        await conexao.query("UPDATE ciclos_leitura SET situacao = 'EM_ANDAMENTO' WHERE id = $1", {
          bind: [planejado.id], transaction: salvamento,
        });
      }, '23505');
      validarDestinoTeste(conexao);
      await conexao.query("UPDATE ciclos_leitura SET situacao = 'CONCLUIDO' WHERE id = $1", {
        bind: [ativo.id], transaction,
      });
      await conexao.query("UPDATE ciclos_leitura SET situacao = 'EM_ANDAMENTO' WHERE id = $1", {
        bind: [planejado.id], transaction,
      });
      const ativos = await conexao.query("SELECT id FROM ciclos_leitura WHERE situacao = 'EM_ANDAMENTO'", {
        type: QueryTypes.SELECT, transaction,
      });
      assert.deepEqual(ativos, [{ id: planejado.id }]);
    });
  });

  it('mantém índice único parcial de uma constante, sem restringir livro_id', async () => {
    const [indice] = await conexao.query(`
      SELECT i.indisunique, i.indnkeyatts,
             pg_get_expr(i.indexprs, i.indrelid) AS expressao,
             pg_get_expr(i.indpred, i.indrelid) AS predicado,
             pg_get_indexdef(i.indexrelid) AS definicao
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'public.ciclos_leitura'::regclass
         AND c.relname = 'ciclos_leitura_unico_em_andamento'
    `, { type: QueryTypes.SELECT });
    assert.ok(indice);
    assert.equal(indice.indisunique, true);
    assert.equal(indice.indnkeyatts, 1);
    assert.equal(indice.expressao.replace(/[()\s]/g, ''), '1');
    assert.match(indice.predicado, /situacao/);
    assert.match(indice.predicado, /EM_ANDAMENTO/);
    assert.doesNotMatch(indice.definicao, /livro_id/);
  });

  it('rejeita intervalo invertido e aceita início igual ao fim em SQL direto', async () => {
    await emTransacao(async (transaction) => {
      const [obra] = await criarObras(transaction);
      await rejeitarBanco(transaction,
        (salvamento) => inserirCiclo(salvamento, obra.id, { data_inicio: '2026-10-31', data_fim: '2026-10-01' }), '23514');
      const ciclo = await inserirCiclo(transaction, obra.id, { data_inicio: '2026-10-15', data_fim: '2026-10-15' });
      assert.equal(ciclo.data_inicio, '2026-10-15');
      assert.equal(ciclo.data_fim, '2026-10-15');
    });
  });

  it('restringe os valores de situação no PostgreSQL e aplica PLANEJADO por padrão', async () => {
    await emTransacao(async (transaction) => {
      const [obra] = await criarObras(transaction);
      assert.equal((await inserirCiclo(transaction, obra.id)).situacao, 'PLANEJADO');
      for (const situacao of ['', 'ATIVO', 'planejado', 'ENCERRADO']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirCiclo(salvamento, obra.id, { situacao }), '23514');
      }
      const [coluna] = await conexao.query(`
        SELECT data_type, character_maximum_length FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ciclos_leitura' AND column_name = 'situacao'
      `, { type: QueryTypes.SELECT, transaction });
      assert.deepEqual(coluna, { data_type: 'character varying', character_maximum_length: 20 });
    });
  });

  it('exige todos os atributos obrigatórios e nome não vazio até 120 caracteres', async () => {
    await emTransacao(async (transaction) => {
      const [obra] = await criarObras(transaction);
      for (const coluna of ['id', 'nome', 'livro_id', 'data_inicio', 'data_fim', 'situacao', 'criado_em', 'atualizado_em']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirCiclo(salvamento, obra.id, { [coluna]: null }), '23502');
      }
      for (const nome of ['', '   ', '\t \n']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirCiclo(salvamento, obra.id, { nome }), '23514');
      }
      assert.equal((await inserirCiclo(transaction, obra.id, { nome: 'n'.repeat(120) })).nome.length, 120);
      await rejeitarBanco(transaction,
        (salvamento) => inserirCiclo(salvamento, obra.id, { nome: 'n'.repeat(121) }), '22001');
    });
  });

  it('aceita orientações omitidas, nulas ou com até 2000 caracteres', async () => {
    await emTransacao(async (transaction) => {
      const [obra] = await criarObras(transaction);
      assert.equal((await inserirCiclo(transaction, obra.id)).orientacoes, null);
      assert.equal((await inserirCiclo(transaction, obra.id, { orientacoes: null })).orientacoes, null);
      assert.equal((await inserirCiclo(transaction, obra.id, { orientacoes: '' })).orientacoes, '');
      const ciclo = await inserirCiclo(transaction, obra.id, { orientacoes: 'o'.repeat(2000) });
      assert.equal(ciclo.orientacoes.length, 2000);
      await rejeitarBanco(transaction,
        (salvamento) => inserirCiclo(salvamento, obra.id, { orientacoes: 'o'.repeat(2001) }), '22001');
    });
  });

  it('rejeita livro inexistente e restringe a exclusão de uma obra utilizada', async () => {
    await emTransacao(async (transaction) => {
      await rejeitarBanco(transaction,
        (salvamento) => inserirCiclo(salvamento, 2147483647), '23503');
      const [obra] = await criarObras(transaction);
      const ciclo = await inserirCiclo(transaction, obra.id);
      await rejeitarBanco(transaction, async (salvamento) => {
        validarDestinoTeste(conexao);
        await conexao.query('DELETE FROM livros WHERE id = $1', { bind: [obra.id], transaction: salvamento });
      }, '23503');
      const mantidos = await conexao.query('SELECT id FROM ciclos_leitura WHERE id = $1', {
        bind: [ciclo.id], type: QueryTypes.SELECT, transaction,
      });
      assert.deepEqual(mantidos, [{ id: ciclo.id }]);
      const [referencia] = await conexao.query(`
        SELECT c.confdeltype FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
         WHERE c.conrelid = 'public.ciclos_leitura'::regclass AND c.contype = 'f' AND a.attname = 'livro_id'
      `, { type: QueryTypes.SELECT, transaction });
      assert.equal(referencia.confdeltype, 'r');
    });
  });

  it('preserva as datas civis DATEONLY entre fusos, sem trocar o dia', async () => {
    await emTransacao(async (transaction) => {
      const [obra] = await criarObras(transaction);
      const { CicloLeitura } = conexao.models;
      await conexao.query("SET LOCAL TIME ZONE 'Pacific/Kiritimati'", { transaction });
      validarDestinoTeste(conexao);
      const ciclo = await CicloLeitura.create({
        nome: 'Datas civis', livroId: obra.id, dataInicio: '2026-01-01', dataFim: '2026-12-31',
      }, { transaction });
      for (const fuso of ['America/Adak', 'UTC']) {
        await conexao.query('SELECT set_config($1, $2, true)', { bind: ['TimeZone', fuso], transaction });
        const registro = await CicloLeitura.findByPk(ciclo.id, { transaction });
        assert.equal(registro.dataInicio, '2026-01-01');
        assert.equal(registro.dataFim, '2026-12-31');
        assert.equal(typeof registro.dataInicio, 'string');
        assert.equal(typeof registro.dataFim, 'string');
      }
      const colunas = await conexao.query(`
        SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ciclos_leitura'
           AND column_name IN ('data_inicio', 'data_fim') ORDER BY column_name
      `, { type: QueryTypes.SELECT, transaction });
      assert.deepEqual(colunas, [
        { column_name: 'data_fim', data_type: 'date' },
        { column_name: 'data_inicio', data_type: 'date' },
      ]);
    });
  });

  it('mantém a situação explícita independentemente das datas passadas ou futuras', async () => {
    await emTransacao(async (transaction) => {
      const [obra] = await criarObras(transaction);
      const { CicloLeitura } = conexao.models;
      for (const [dataInicio, dataFim] of [['2000-01-01', '2000-01-31'], ['2100-01-01', '2100-01-31']]) {
        const ciclo = await CicloLeitura.create({ nome: 'Planejamento explícito', livroId: obra.id, dataInicio, dataFim }, { transaction });
        assert.equal(ciclo.situacao, 'PLANEJADO');
      }
      const ativoPassado = await inserirCiclo(transaction, obra.id, {
        data_inicio: '2000-01-01', data_fim: '2000-01-31', situacao: 'EM_ANDAMENTO',
      });
      const concluidoFuturo = await inserirCiclo(transaction, obra.id, {
        data_inicio: '2100-01-01', data_fim: '2100-01-31', situacao: 'CONCLUIDO',
      });
      assert.equal(ativoPassado.situacao, 'EM_ANDAMENTO');
      assert.equal(concluidoFuturo.situacao, 'CONCLUIDO');
    });
  });

  it('associa a mesma obra a vários ciclos com aliases e apenas livro_id', async () => {
    await emTransacao(async (transaction) => {
      const [obra] = await criarObras(transaction);
      const { Livro, CicloLeitura } = conexao.models;
      const primeiro = await CicloLeitura.create({
        nome: 'Primeiro ciclo da mesma obra', livroId: obra.id, dataInicio: '2026-01-01', dataFim: '2026-01-31',
      }, { transaction });
      const segundo = await CicloLeitura.create({
        nome: 'Segundo ciclo da mesma obra', livroId: obra.id, dataInicio: '2026-06-01', dataFim: '2026-06-30',
      }, { transaction });
      const comCiclos = await Livro.findByPk(obra.id, { include: ['ciclosLeitura'], transaction });
      assert.deepEqual(comCiclos.ciclosLeitura.map((ciclo) => ciclo.id).sort((a, b) => a - b), [primeiro.id, segundo.id]);
      const comLivro = await CicloLeitura.findByPk(primeiro.id, { include: ['livro'], transaction });
      assert.equal(comLivro.livro.id, obra.id);
      assert.equal(await Livro.count({ where: { id: obra.id }, transaction }), 1);
      assert.deepEqual(Object.entries(CicloLeitura.rawAttributes)
        .filter(([, atributo]) => atributo.field === 'livro_id').map(([nome]) => nome), ['livroId']);
      const colunas = await conexao.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ciclos_leitura' ORDER BY column_name
      `, { type: QueryTypes.SELECT, transaction });
      assert.deepEqual(colunas.map((coluna) => coluna.column_name), [
        'atualizado_em', 'criado_em', 'data_fim', 'data_inicio', 'id', 'livro_id', 'nome', 'orientacoes', 'situacao',
      ]);
    });
  });
});
