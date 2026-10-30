'use strict';

const assert = require('node:assert/strict');
const { scryptSync } = require('node:crypto');
const { after, before, describe, it } = require('node:test');
const { QueryTypes } = require('sequelize');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { criarConexao } = require('../../database/conexao');

// Pós-migrations: nenhum dado persiste fora das transações revertidas.
// O schema garante integridade; as regras que consultam estado de usuário,
// páginas do livro ou adesão ao mesmo ciclo pertencem aos serviços.
validarBancoTeste(process.env);
const sal = 'leia-adesoes-integracao';
const senhaHash = `scrypt$${sal}$${scryptSync('entrada exclusiva do teste', sal, 32).toString('hex')}`;
let sequencia = 0;

describe('Participações e inscrições no PostgreSQL de teste', { timeout: 25_000 }, () => {
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

  async function criarUsuario(transaction) {
    validarDestinoTeste(conexao);
    sequencia += 1;
    return conexao.models.Usuario.create({
      nome: 'Leitor das adesões', email: `adesao-${sequencia}@escola.example`, senhaHash,
    }, { transaction });
  }

  async function criarCiclo(transaction) {
    validarDestinoTeste(conexao);
    sequencia += 1;
    const { Genero, Livro, CicloLeitura } = conexao.models;
    const genero = await Genero.create({ nome: `Gênero para adesões ${sequencia}` }, { transaction });
    const livro = await Livro.create({
      titulo: 'Obra das adesões', autor: 'Autora', generoId: genero.id, totalPaginas: 120,
    }, { transaction });
    return CicloLeitura.create({
      nome: `Ciclo das adesões ${sequencia}`, livroId: livro.id,
      dataInicio: '2026-11-01', dataFim: '2026-11-30',
    }, { transaction });
  }

  async function criarEncontro(transaction, cicloId) {
    validarDestinoTeste(conexao);
    return conexao.models.Encontro.create({
      cicloId, titulo: 'Encontro das adesões', inicioEm: '2026-11-10T10:30:00-03:00', local: 'Biblioteca',
    }, { transaction });
  }

  async function inserir(tabela, transaction, atributos) {
    validarDestinoTeste(conexao);
    const valores = {
      criado_em: new Date('2026-10-30T12:00:00Z'),
      atualizado_em: new Date('2026-10-30T12:00:00Z'),
      ...atributos,
    };
    const colunas = Object.keys(valores);
    const [linhas] = await conexao.query(`
      INSERT INTO "${tabela}" (${colunas.map((coluna) => `"${coluna}"`).join(', ')})
      VALUES (${colunas.map((coluna, indice) => `$${indice + 1}`).join(', ')}) RETURNING *
    `, { bind: Object.values(valores), transaction });
    return linhas[0];
  }

  function inserirParticipacao(transaction, usuarioId, cicloId, alteracoes = {}) {
    return inserir('participacoes_leitura', transaction, { usuario_id: usuarioId, ciclo_id: cicloId, ...alteracoes });
  }

  function inserirInscricao(transaction, usuarioId, encontroId, alteracoes = {}) {
    return inserir('inscricoes_encontro', transaction, { usuario_id: usuarioId, encontro_id: encontroId, ...alteracoes });
  }

  it('persiste a adesão com página zero, conclusão opcional e timestamps camelCase', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const bruto = await inserirParticipacao(transaction, usuario.id, ciclo.id);
      assert.ok(Number.isInteger(bruto.id) && bruto.id > 0);
      assert.equal(bruto.pagina_atual, 0);
      assert.equal(bruto.concluida_em, null);
      const participacao = await conexao.models.ParticipacaoLeitura.findByPk(bruto.id, { transaction });
      assert.equal(participacao.usuarioId, usuario.id);
      assert.equal(participacao.cicloId, ciclo.id);
      assert.equal(participacao.paginaAtual, 0);
      assert.equal(participacao.concluidaEm, null);
      assert.ok(participacao.criadoEm instanceof Date);
      assert.ok(participacao.atualizadoEm instanceof Date);
      assert.equal(participacao.cicloLeituraId, undefined);
    });
  });

  it('rejeita páginas negativas, nulas e fracionárias em SQL direto', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      for (const [pagina_atual, codigo] of [[-1, '23514'], [null, '23502'], [0.5, '22P02']]) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirParticipacao(salvamento, usuario.id, ciclo.id, { pagina_atual }), codigo);
      }
      const zero = await inserirParticipacao(transaction, usuario.id, ciclo.id, { pagina_atual: 0 });
      assert.equal(zero.pagina_atual, 0);
      await conexao.query('UPDATE participacoes_leitura SET pagina_atual = $1 WHERE id = $2', {
        bind: [25, zero.id], transaction,
      });
      assert.equal((await conexao.models.ParticipacaoLeitura.findByPk(zero.id, { transaction })).paginaAtual, 25);
    });
  });

  it('impõe obrigatoriedade nas duas junções, preservando os defaults válidos', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const encontro = await criarEncontro(transaction, ciclo.id);
      for (const coluna of ['id', 'usuario_id', 'ciclo_id', 'pagina_atual', 'criado_em', 'atualizado_em']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirParticipacao(salvamento, usuario.id, ciclo.id, { [coluna]: null }), '23502');
      }
      for (const coluna of ['id', 'usuario_id', 'encontro_id', 'criado_em', 'atualizado_em']) {
        await rejeitarBanco(transaction,
          (salvamento) => inserirInscricao(salvamento, usuario.id, encontro.id, { [coluna]: null }), '23502');
      }
      for (const tabela of ['participacoes_leitura', 'inscricoes_encontro']) {
        const colunas = await conexao.query(`
          SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name IN ('criado_em', 'atualizado_em')
        `, { bind: [tabela], type: QueryTypes.SELECT, transaction });
        assert.equal(colunas.length, 2);
        assert.ok(colunas.every((coluna) => coluna.is_nullable === 'NO'));
      }
    });
  });

  it('aplica UNIQUE(usuario_id, ciclo_id) sem limitar adesões a outros ciclos ou usuários', async () => {
    await emTransacao(async (transaction) => {
      const primeiro = await criarUsuario(transaction);
      const segundo = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const outroCiclo = await criarCiclo(transaction);
      await inserirParticipacao(transaction, primeiro.id, ciclo.id);
      await rejeitarBanco(transaction,
        (salvamento) => inserirParticipacao(salvamento, primeiro.id, ciclo.id), '23505');
      await inserirParticipacao(transaction, primeiro.id, outroCiclo.id);
      await inserirParticipacao(transaction, segundo.id, ciclo.id);
      assert.equal(await conexao.models.ParticipacaoLeitura.count({ transaction }), 3);
    });
  });

  it('aplica UNIQUE(usuario_id, encontro_id) sem limitar inscrições em outros encontros', async () => {
    await emTransacao(async (transaction) => {
      const primeiro = await criarUsuario(transaction);
      const segundo = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const encontro = await criarEncontro(transaction, ciclo.id);
      const outroEncontro = await criarEncontro(transaction, ciclo.id);
      await inserirInscricao(transaction, primeiro.id, encontro.id);
      await rejeitarBanco(transaction,
        (salvamento) => inserirInscricao(salvamento, primeiro.id, encontro.id), '23505');
      await inserirInscricao(transaction, primeiro.id, outroEncontro.id);
      await inserirInscricao(transaction, segundo.id, encontro.id);
      assert.equal(await conexao.models.InscricaoEncontro.count({ transaction }), 3);
    });
  });

  it('recusa as quatro FKs inexistentes em SQL direto', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const encontro = await criarEncontro(transaction, ciclo.id);
      const ausente = 2147483647;
      await rejeitarBanco(transaction,
        (salvamento) => inserirParticipacao(salvamento, ausente, ciclo.id), '23503');
      await rejeitarBanco(transaction,
        (salvamento) => inserirParticipacao(salvamento, usuario.id, ausente), '23503');
      await rejeitarBanco(transaction,
        (salvamento) => inserirInscricao(salvamento, ausente, encontro.id), '23503');
      await rejeitarBanco(transaction,
        (salvamento) => inserirInscricao(salvamento, usuario.id, ausente), '23503');
    });
  });

  it('persiste a conclusão com fuso sem derivar páginas ou presença', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const participacao = await conexao.models.ParticipacaoLeitura.create({
        usuarioId: usuario.id, cicloId: ciclo.id, concluidaEm: '2026-11-20T10:30:45.123-03:00',
      }, { transaction });
      const persistida = await conexao.models.ParticipacaoLeitura.findByPk(participacao.id, { transaction });
      assert.equal(persistida.concluidaEm.toISOString(), '2026-11-20T13:30:45.123Z');
      assert.equal(persistida.paginaAtual, 0);
      const [coluna] = await conexao.query(`
        SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'participacoes_leitura' AND column_name = 'concluida_em'
      `, { type: QueryTypes.SELECT, transaction });
      assert.deepEqual(coluna, { data_type: 'timestamp with time zone', is_nullable: 'YES' });
    });
  });

  it('consulta e adiciona adesões pelas associações diretas e belongsToMany', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const outroCiclo = await criarCiclo(transaction);
      const { Usuario, CicloLeitura, ParticipacaoLeitura } = conexao.models;
      const participacao = await ParticipacaoLeitura.create({ usuarioId: usuario.id, cicloId: ciclo.id }, { transaction });
      const incluida = await ParticipacaoLeitura.findByPk(participacao.id, { include: ['usuario', 'ciclo'], transaction });
      assert.equal(incluida.usuario.id, usuario.id);
      assert.equal(incluida.ciclo.id, ciclo.id);
      assert.equal(Object.hasOwn(incluida.usuario.toJSON(), 'senhaHash'), false);
      await usuario[Usuario.associations.ciclosLeitura.accessors.add](outroCiclo, {
        through: { paginaAtual: 10 }, transaction,
      });
      const comCiclos = await Usuario.findByPk(usuario.id, { include: ['ciclosLeitura', 'participacoesLeitura'], transaction });
      assert.deepEqual(comCiclos.ciclosLeitura.map((item) => item.id).sort((a, b) => a - b), [ciclo.id, outroCiclo.id]);
      assert.equal(comCiclos.participacoesLeitura.length, 2);
      const comUsuarios = await CicloLeitura.findByPk(outroCiclo.id, { include: ['usuariosParticipantes', 'participacoesLeitura'], transaction });
      assert.equal(comUsuarios.usuariosParticipantes[0].id, usuario.id);
      assert.equal(comUsuarios.participacoesLeitura[0].paginaAtual, 10);
    });
  });

  it('consulta e adiciona inscrições pelas associações diretas e belongsToMany', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const outroUsuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const encontro = await criarEncontro(transaction, ciclo.id);
      const { Usuario, Encontro, InscricaoEncontro } = conexao.models;
      const inscricao = await InscricaoEncontro.create({ usuarioId: usuario.id, encontroId: encontro.id }, { transaction });
      const incluida = await InscricaoEncontro.findByPk(inscricao.id, { include: ['usuario', 'encontro'], transaction });
      assert.equal(incluida.usuario.id, usuario.id);
      assert.equal(incluida.encontro.id, encontro.id);
      await encontro[Encontro.associations.usuariosInscritos.accessors.add](outroUsuario, { transaction });
      const comUsuarios = await Encontro.findByPk(encontro.id, { include: ['usuariosInscritos', 'inscricoesEncontro'], transaction });
      assert.deepEqual(comUsuarios.usuariosInscritos.map((item) => item.id).sort((a, b) => a - b), [usuario.id, outroUsuario.id]);
      assert.equal(comUsuarios.inscricoesEncontro.length, 2);
      const comEncontros = await Usuario.findByPk(outroUsuario.id, { include: ['encontrosInscritos', 'inscricoesEncontro'], transaction });
      assert.equal(comEncontros.encontrosInscritos[0].id, encontro.id);
      assert.equal(comEncontros.inscricoesEncontro[0].encontroId, encontro.id);
    });
  });

  it('não cria colunas, constraints ou unicidades extras por belongsToMany', async () => {
    const especificacoes = [
      ['participacoes_leitura', conexao.models.ParticipacaoLeitura, ['atualizado_em', 'ciclo_id', 'concluida_em', 'criado_em', 'id', 'pagina_atual', 'usuario_id']],
      ['inscricoes_encontro', conexao.models.InscricaoEncontro, ['atualizado_em', 'criado_em', 'encontro_id', 'id', 'usuario_id']],
    ];
    for (const [tabela, modelo, esperadas] of especificacoes) {
      const colunas = await conexao.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name
      `, { bind: [tabela], type: QueryTypes.SELECT });
      assert.deepEqual(colunas.map((coluna) => coluna.column_name), esperadas);
      assert.deepEqual(Object.values(modelo.rawAttributes).map((atributo) => atributo.field).sort(), esperadas);
      const chaves = await conexao.query(`
        SELECT contype, pg_get_constraintdef(oid) AS definicao FROM pg_catalog.pg_constraint
         WHERE conrelid = $1::regclass AND contype IN ('p', 'u', 'f') ORDER BY contype, conname
      `, { bind: [tabela], type: QueryTypes.SELECT });
      assert.equal(chaves.filter((chave) => chave.contype === 'p').length, 1);
      assert.equal(chaves.filter((chave) => chave.contype === 'u').length, 1);
      assert.equal(chaves.filter((chave) => chave.contype === 'f').length, 2);
      assert.equal(chaves.find((chave) => chave.contype === 'p').definicao, 'PRIMARY KEY (id)');
      assert.match(chaves.find((chave) => chave.contype === 'u').definicao,
        tabela === 'participacoes_leitura' ? /UNIQUE \(usuario_id, ciclo_id\)/ : /UNIQUE \(usuario_id, encontro_id\)/);
    }
  });

  it('mantém as ações de exclusão do model iguais às quatro FKs do PostgreSQL', async () => {
    for (const [tabela, modelo, campos] of [
      ['participacoes_leitura', conexao.models.ParticipacaoLeitura, [['usuarioId', 'usuario_id', 'r'], ['cicloId', 'ciclo_id', 'r']]],
      ['inscricoes_encontro', conexao.models.InscricaoEncontro, [['usuarioId', 'usuario_id', 'r'], ['encontroId', 'encontro_id', 'c']]],
    ]) {
      const chaves = await conexao.query(`
        SELECT a.attname AS coluna, c.confdeltype
          FROM pg_catalog.pg_constraint c
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
         WHERE c.conrelid = $1::regclass AND c.contype = 'f'
      `, { bind: [tabela], type: QueryTypes.SELECT });
      assert.equal(chaves.length, 2);
      for (const [atributo, coluna, exclusao] of campos) {
        assert.equal(chaves.find((chave) => chave.coluna === coluna).confdeltype, exclusao);
        assert.equal(modelo.rawAttributes[atributo].onDelete, exclusao === 'r' ? 'RESTRICT' : 'CASCADE');
      }
    }
  });

  it('bloqueia exclusão de usuário com participação sem apagar a adesão ou o ciclo', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const participacao = await inserirParticipacao(transaction, usuario.id, ciclo.id);
      await rejeitarBanco(transaction, (salvamento) => conexao.query('DELETE FROM usuarios WHERE id = $1', {
        bind: [usuario.id], transaction: salvamento,
      }), '23503');
      assert.ok(await conexao.models.Usuario.findByPk(usuario.id, { transaction }));
      assert.ok(await conexao.models.ParticipacaoLeitura.findByPk(participacao.id, { transaction }));
      assert.ok(await conexao.models.CicloLeitura.findByPk(ciclo.id, { transaction }));
    });
  });

  it('bloqueia exclusão de usuário com inscrição mesmo sem participação no ciclo', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const encontro = await criarEncontro(transaction, ciclo.id);
      const inscricao = await inserirInscricao(transaction, usuario.id, encontro.id);
      await rejeitarBanco(transaction, (salvamento) => conexao.query('DELETE FROM usuarios WHERE id = $1', {
        bind: [usuario.id], transaction: salvamento,
      }), '23503');
      assert.ok(await conexao.models.Usuario.findByPk(usuario.id, { transaction }));
      assert.ok(await conexao.models.InscricaoEncontro.findByPk(inscricao.id, { transaction }));
      assert.ok(await conexao.models.Encontro.findByPk(encontro.id, { transaction }));
    });
  });

  it('bloqueia exclusão de ciclo com participação mesmo quando não há encontro', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const participacao = await inserirParticipacao(transaction, usuario.id, ciclo.id);
      await rejeitarBanco(transaction, (salvamento) => conexao.query('DELETE FROM ciclos_leitura WHERE id = $1', {
        bind: [ciclo.id], transaction: salvamento,
      }), '23503');
      assert.ok(await conexao.models.CicloLeitura.findByPk(ciclo.id, { transaction }));
      assert.ok(await conexao.models.ParticipacaoLeitura.findByPk(participacao.id, { transaction }));
      assert.ok(await conexao.models.Usuario.findByPk(usuario.id, { transaction }));
    });
  });

  it('excluir encontro remove somente suas inscrições em cascata e preserva todo o restante', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const outroUsuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const excluido = await criarEncontro(transaction, ciclo.id);
      const mantido = await criarEncontro(transaction, ciclo.id);
      const primeira = await inserirParticipacao(transaction, usuario.id, ciclo.id, { pagina_atual: 10 });
      const segunda = await inserirParticipacao(transaction, outroUsuario.id, ciclo.id, { pagina_atual: 20 });
      const inscricoes = [
        await inserirInscricao(transaction, usuario.id, excluido.id),
        await inserirInscricao(transaction, outroUsuario.id, excluido.id),
      ];
      const preservada = await inserirInscricao(transaction, usuario.id, mantido.id);
      validarDestinoTeste(conexao);
      await conexao.query('DELETE FROM encontros WHERE id = $1', { bind: [excluido.id], transaction });
      const { Usuario, CicloLeitura, Livro, Genero, Encontro, ParticipacaoLeitura, InscricaoEncontro } = conexao.models;
      assert.equal(await Encontro.findByPk(excluido.id, { transaction }), null);
      for (const inscricao of inscricoes) assert.equal(await InscricaoEncontro.findByPk(inscricao.id, { transaction }), null);
      assert.ok(await InscricaoEncontro.findByPk(preservada.id, { transaction }));
      assert.ok(await Encontro.findByPk(mantido.id, { transaction }));
      assert.ok(await Usuario.findByPk(usuario.id, { transaction }));
      assert.ok(await Usuario.findByPk(outroUsuario.id, { transaction }));
      assert.ok(await CicloLeitura.findByPk(ciclo.id, { transaction }));
      const livro = await Livro.findByPk(ciclo.livroId, { transaction });
      assert.ok(livro);
      assert.ok(await Genero.findByPk(livro.generoId, { transaction }));
      assert.equal((await ParticipacaoLeitura.findByPk(primeira.id, { transaction })).paginaAtual, 10);
      assert.equal((await ParticipacaoLeitura.findByPk(segunda.id, { transaction })).paginaAtual, 20);
    });
  });

  it('deixa usuário ativo, limite superior da página e mesmo ciclo para os serviços', async () => {
    await emTransacao(async (transaction) => {
      const usuario = await criarUsuario(transaction);
      const ciclo = await criarCiclo(transaction);
      const outroCiclo = await criarCiclo(transaction);
      const encontro = await criarEncontro(transaction, outroCiclo.id);
      assert.equal(usuario.situacao, 'PENDENTE');
      const participacao = await conexao.models.ParticipacaoLeitura.create({
        usuarioId: usuario.id, cicloId: ciclo.id, paginaAtual: 9999,
      }, { transaction });
      const inscricao = await conexao.models.InscricaoEncontro.create({
        usuarioId: usuario.id, encontroId: encontro.id,
      }, { transaction });
      assert.equal(participacao.paginaAtual, 9999);
      assert.ok(inscricao.id > 0);
      assert.equal(await conexao.models.ParticipacaoLeitura.count({
        where: { usuarioId: usuario.id, cicloId: outroCiclo.id }, transaction,
      }), 0);
    });
  });
});
