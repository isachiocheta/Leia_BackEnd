'use strict';

const assert = require('node:assert/strict');
const { scryptSync } = require('node:crypto');
const { after, before, describe, it } = require('node:test');
const { QueryTypes } = require('sequelize');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { criarConexao } = require('../../database/conexao');

// Pós-migrations: os dados pertencem apenas a transações revertidas no banco
// de teste. O limite temporal do ciclo será validado no serviço, não neste schema.
validarBancoTeste(process.env);
let sequencia = 0;

describe('Encontros no PostgreSQL de teste', { timeout: 20_000 }, () => {
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

  async function criarCiclo(transaction) {
    validarDestinoTeste(conexao);
    sequencia += 1;
    const { Genero, Livro, CicloLeitura } = conexao.models;
    const genero = await Genero.create({ nome: `Gênero para encontros ${sequencia}` }, { transaction });
    const livro = await Livro.create({
      titulo: 'Obra para os encontros', autor: 'Autora', generoId: genero.id, totalPaginas: 120,
    }, { transaction });
    return CicloLeitura.create({
      nome: `Ciclo dos encontros ${sequencia}`, livroId: livro.id,
      dataInicio: '2026-11-01', dataFim: '2026-11-30',
    }, { transaction });
  }

  async function inserirEncontro(transaction, cicloId, alteracoes = {}) {
    validarDestinoTeste(conexao);
    const atributos = {
      ciclo_id: cicloId,
      titulo: 'Conversa sobre a obra',
      inicio_em: '2026-11-10T10:30:45.123-03:00',
      local: 'Biblioteca da escola',
      criado_em: new Date('2026-10-30T12:00:00Z'),
      atualizado_em: new Date('2026-10-30T12:00:00Z'),
      ...alteracoes,
    };
    const colunas = Object.keys(atributos);
    const [linhas] = await conexao.query(`
      INSERT INTO encontros (${colunas.map((coluna) => `"${coluna}"`).join(', ')})
      VALUES (${colunas.map((coluna, indice) => `$${indice + 1}`).join(', ')}) RETURNING *
    `, { bind: Object.values(atributos), transaction });
    return linhas[0];
  }

  it('persiste e atualiza o instante com offset pelos models e mapeia os timestamps', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      const { Encontro } = conexao.models;
      const encontro = await Encontro.create({
        cicloId: ciclo.id, titulo: 'Encontro do model', inicioEm: '2026-11-10T10:30:45.123-03:00', local: 'Biblioteca',
      }, { transaction });
      const persistido = await Encontro.findByPk(encontro.id, { transaction });

      assert.ok(Number.isInteger(persistido.id) && persistido.id > 0);
      assert.equal(persistido.cicloId, ciclo.id);
      assert.equal(persistido.inicioEm.toISOString(), '2026-11-10T13:30:45.123Z');
      assert.equal(persistido.situacao, 'AGENDADO');
      assert.ok(persistido.criadoEm instanceof Date);
      assert.ok(persistido.atualizadoEm instanceof Date);
      assert.equal(persistido.dataHora, undefined);
      assert.equal(persistido.cicloLeituraId, undefined);
      assert.equal(persistido.criado_em, undefined);

      await encontro.update({ inicioEm: '2026-11-11T17:15:00+04:00', situacao: 'REALIZADO' }, { transaction });
      const atualizado = await Encontro.findByPk(encontro.id, { transaction });
      assert.equal(atualizado.inicioEm.toISOString(), '2026-11-11T13:15:00.000Z');
      assert.equal(atualizado.situacao, 'REALIZADO');
    });
  });

  it('usa timestamptz e preserva o mesmo instante ao consultar em outros fusos', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      const encontro = await inserirEncontro(transaction, ciclo.id);
      const esperado = Date.parse('2026-11-10T13:30:45.123Z') / 1000;
      for (const fuso of ['UTC', 'America/Sao_Paulo', 'Pacific/Kiritimati', 'America/Adak']) {
        await conexao.query("SELECT set_config('TimeZone', $1, true)", { bind: [fuso], transaction });
        const [linha] = await conexao.query(`
          SELECT inicio_em, EXTRACT(EPOCH FROM inicio_em) AS instante FROM encontros WHERE id = $1
        `, { bind: [encontro.id], type: QueryTypes.SELECT, transaction });
        assert.equal(Number(linha.instante), esperado);
        assert.equal(linha.inicio_em.toISOString(), '2026-11-10T13:30:45.123Z');
      }

      const [coluna] = await conexao.query(`
        SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'encontros' AND column_name = 'inicio_em'
      `, { type: QueryTypes.SELECT, transaction });
      assert.deepEqual(coluna, { data_type: 'timestamp with time zone', is_nullable: 'NO' });
    });
  });

  it('carrega os aliases encontros e ciclo sem gerar outra coluna de ciclo', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      const primeiro = await inserirEncontro(transaction, ciclo.id, { titulo: 'Primeiro encontro' });
      const segundo = await inserirEncontro(transaction, ciclo.id, { titulo: 'Segundo encontro' });
      const { CicloLeitura, Encontro } = conexao.models;
      const comEncontros = await CicloLeitura.findByPk(ciclo.id, { include: ['encontros'], transaction });
      assert.deepEqual(comEncontros.encontros.map((encontro) => encontro.id).sort((a, b) => a - b), [primeiro.id, segundo.id]);
      const comCiclo = await Encontro.findByPk(primeiro.id, { include: ['ciclo'], transaction });
      assert.equal(comCiclo.ciclo.id, ciclo.id);
      assert.equal(comCiclo.ciclo.nome, ciclo.nome);

      const colunas = await conexao.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'encontros' ORDER BY column_name
      `, { type: QueryTypes.SELECT, transaction });
      assert.deepEqual(colunas.map((coluna) => coluna.column_name), [
        'atualizado_em', 'ciclo_id', 'criado_em', 'descricao', 'id', 'inicio_em', 'local', 'situacao', 'titulo',
      ]);
      const atributos = Object.entries(Encontro.rawAttributes).filter(([, atributo]) => atributo.field === 'ciclo_id');
      assert.deepEqual(atributos.map(([nome]) => nome), ['cicloId']);
    });
  });

  it('aceita descrição omitida, nula ou com até 2000 caracteres', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      assert.equal((await inserirEncontro(transaction, ciclo.id)).descricao, null);
      for (const descricao of [null, '', 'd'.repeat(2000)]) {
        const encontro = await inserirEncontro(transaction, ciclo.id, { descricao });
        assert.equal(encontro.descricao, descricao);
      }
      await rejeitarBanco(transaction,
        (salvamento) => inserirEncontro(salvamento, ciclo.id, { descricao: 'd'.repeat(2001) }), '22001');
    });
  });

  it('impõe todos os campos obrigatórios no PostgreSQL, inclusive os de valor padrão', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      for (const campo of ['id', 'ciclo_id', 'titulo', 'inicio_em', 'local', 'situacao', 'criado_em', 'atualizado_em']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirEncontro(salvamento, ciclo.id, { [campo]: null }), '23502');
      }
    });
  });

  it('rejeita título e local vazios ou compostos apenas de espaços em branco', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      for (const campo of ['titulo', 'local']) {
        for (const valor of ['', '   ', '\t \n']) {
          await rejeitarBanco(transaction,
            (salvamento) => inserirEncontro(salvamento, ciclo.id, { [campo]: valor }), '23514');
        }
      }
    });
  });

  it('preserva limites de 120 caracteres para título e 180 para local', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      const encontro = await inserirEncontro(transaction, ciclo.id, { titulo: 't'.repeat(120), local: 'l'.repeat(180) });
      assert.equal(encontro.titulo.length, 120);
      assert.equal(encontro.local.length, 180);
      for (const [campo, tamanho] of [['titulo', 121], ['local', 181]]) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirEncontro(salvamento, ciclo.id, { [campo]: 'x'.repeat(tamanho) }), '22001');
      }
    });
  });

  it('aplica AGENDADO por padrão e aceita somente as situações declaradas', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      assert.equal((await inserirEncontro(transaction, ciclo.id)).situacao, 'AGENDADO');
      for (const situacao of ['AGENDADO', 'REALIZADO', 'CANCELADO']) {
        assert.equal((await inserirEncontro(transaction, ciclo.id, { situacao })).situacao, situacao);
      }
      for (const situacao of ['', 'agendado', 'PLANEJADO', 'PENDENTE']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirEncontro(salvamento, ciclo.id, { situacao }), '23514');
      }
      const [coluna] = await conexao.query(`
        SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'encontros' AND column_name = 'situacao'
      `, { type: QueryTypes.SELECT, transaction });
      assert.equal(coluna.data_type, 'character varying');
    });
  });

  it('rejeita ciclo inexistente pela chave estrangeira', async () => {
    await emTransacao(async (transaction) => {
      await rejeitarBanco(transaction,
        (salvamento) => inserirEncontro(salvamento, 2147483647), '23503');
    });
  });

  it('bloqueia a exclusão de um ciclo com encontro pela FK RESTRICT', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      const encontro = await inserirEncontro(transaction, ciclo.id);
      await rejeitarBanco(transaction, async (salvamento) => {
        validarDestinoTeste(conexao);
        await conexao.models.CicloLeitura.destroy({ where: { id: ciclo.id }, transaction: salvamento });
      }, '23503');
      assert.ok(await conexao.models.CicloLeitura.findByPk(ciclo.id, { transaction }));
      assert.ok(await conexao.models.Encontro.findByPk(encontro.id, { transaction }));
      const chaves = await conexao.query(`
        SELECT confdeltype, pg_get_constraintdef(oid) AS definicao FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.encontros'::regclass AND contype = 'f'
      `, { type: QueryTypes.SELECT, transaction });
      assert.equal(chaves.length, 1);
      assert.equal(chaves[0].confdeltype, 'r');
      assert.match(chaves[0].definicao, /FOREIGN KEY \(ciclo_id\) REFERENCES ciclos_leitura\(id\)/);
    });
  });

  it('permite no schema e no model datas fora do ciclo para a futura validação do serviço', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      const { Encontro } = conexao.models;
      const anterior = await Encontro.create({
        cicloId: ciclo.id, titulo: 'Antes do ciclo', local: 'Biblioteca', inicioEm: '2025-01-01T12:00:00Z',
      }, { transaction });
      const posterior = await inserirEncontro(transaction, ciclo.id, { inicio_em: '2027-01-01T12:00:00Z' });
      assert.equal(anterior.situacao, 'AGENDADO');
      assert.equal(posterior.situacao, 'AGENDADO');
      assert.equal(anterior.inicioEm.toISOString(), '2025-01-01T12:00:00.000Z');
      assert.equal(posterior.inicio_em.toISOString(), '2027-01-01T12:00:00.000Z');
    });
  });

  it('mantém somente os dois índices de consulta não redundantes e ordena por ciclo e início', async () => {
    await emTransacao(async (transaction) => {
      const indices = await conexao.query(`
        SELECT c.relname AS nome, i.indisunique,
               ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)
                       FROM generate_series(1, i.indnkeyatts::integer) k ORDER BY k) AS campos
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = 'public.encontros'::regclass AND NOT i.indisprimary
         ORDER BY c.relname
      `, { type: QueryTypes.SELECT, transaction });
      assert.deepEqual(indices, [
        { nome: 'encontros_ciclo_inicio_indice', indisunique: false, campos: ['ciclo_id', 'inicio_em'] },
        { nome: 'encontros_inicio_indice', indisunique: false, campos: ['inicio_em'] },
      ]);

      const ciclo = await criarCiclo(transaction);
      const tarde = await inserirEncontro(transaction, ciclo.id, { inicio_em: '2026-11-20T12:00:00Z' });
      const cedo = await inserirEncontro(transaction, ciclo.id, { inicio_em: '2026-11-02T12:00:00Z' });
      const ordenados = await conexao.models.Encontro.findAll({
        where: { cicloId: ciclo.id }, order: [['inicioEm', 'ASC']], transaction,
      });
      assert.deepEqual(ordenados.map((encontro) => encontro.id), [cedo.id, tarde.id]);
    });
  });

  it('preserva as inscrições e a associação do encontro após renomear a FK do ciclo', async () => {
    await emTransacao(async (transaction) => {
      const ciclo = await criarCiclo(transaction);
      const encontro = await inserirEncontro(transaction, ciclo.id);
      const { Usuario, InscricaoEncontro, Encontro } = conexao.models;
      const sal = 'leia-mais-integracao-encontros';
      const senhaHash = `scrypt$${sal}$${scryptSync('entrada de teste', sal, 32).toString('hex')}`;
      const usuario = await Usuario.create({ nome: 'Participante do encontro', email: 'participante.encontro@escola.example', senhaHash }, { transaction });
      const inscricao = await InscricaoEncontro.create({ usuarioId: usuario.id, encontroId: encontro.id }, { transaction });
      const comEncontro = await InscricaoEncontro.findByPk(inscricao.id, { include: ['encontro'], transaction });
      assert.equal(comEncontro.encontro.id, encontro.id);
      assert.equal(comEncontro.encontro.cicloId, ciclo.id);
      const comInscricoes = await Encontro.findByPk(encontro.id, { include: ['inscricoesEncontro'], transaction });
      assert.equal(comInscricoes.inscricoesEncontro.length, 1);
      assert.equal(comInscricoes.inscricoesEncontro[0].usuarioId, usuario.id);
    });
  });
});
