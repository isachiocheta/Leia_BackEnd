'use strict';

const bcrypt = require('bcrypt');
const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const banco = require('./conexao');
const { carregarDemonstracao } = require('../configuracao/demonstracao');
const { criarPlano } = require('./demonstracao/plano');
const { dataEmSaoPaulo } = require('../utilitarios/datas-civis');

const CHAVE = 'leia_demo_v1';
const grupos = { livros: 'Livro', ciclos: 'CicloLeitura', encontros: 'Encontro', usuarios: 'Usuario', participacoes: 'ParticipacaoLeitura', inscricoes: 'InscricaoEncontro' };

function conflito() {
  const erro = new Error('Conflito na demonstração: confira identidades, manifesto, data-base e outro ciclo em andamento. Nenhum dado foi alterado.');
  erro.codigo = 'CONFLITO_DEMONSTRACAO'; return erro;
}

async function validarManifesto(manifesto, plano, conexao, transaction) {
  if (manifesto?.versao !== 1 || !manifesto.ids) throw conflito();
  const registros = {};
  // Mesma ordem dos escritores: livros, ciclos, encontros, usuários e junções.
  for (const [grupo, modelo] of Object.entries(grupos)) {
    const ids = manifesto.ids[grupo]; const chaves = Object.keys(plano[grupo]);
    if (!ids || Object.keys(ids).length !== chaves.length || chaves.some((chave) => !Number.isInteger(ids[chave]) || ids[chave] < 1) || new Set(Object.values(ids)).size !== chaves.length) throw conflito();
    const linhas = await conexao.models[modelo].findAll({ where: { id: Object.values(ids) }, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.SHARE });
    if (linhas.length !== chaves.length) throw conflito();
    registros[grupo] = Object.fromEntries(chaves.map((chave) => [chave, linhas.find((linha) => linha.id === ids[chave])]));
  }
  const ids = manifesto.ids;
  for (const [chave, dados] of Object.entries(plano.usuarios)) if (registros.usuarios[chave].email !== dados.email || registros.usuarios[chave].perfil !== 'LEITOR') throw conflito();
  for (const [chave, dados] of Object.entries(plano.ciclos)) if (registros.ciclos[chave].livroId !== ids.livros[dados.livro]) throw conflito();
  for (const [chave, dados] of Object.entries(plano.encontros)) if (registros.encontros[chave].cicloId !== ids.ciclos[dados.ciclo]) throw conflito();
  for (const [chave, dados] of Object.entries(plano.participacoes)) {
    const registro = registros.participacoes[chave];
    if (registro.usuarioId !== ids.usuarios[dados.usuario] || registro.cicloId !== ids.ciclos[dados.ciclo]) throw conflito();
  }
  for (const [chave, dados] of Object.entries(plano.inscricoes)) {
    const registro = registros.inscricoes[chave];
    if (registro.usuarioId !== ids.usuarios[dados.usuario] || registro.encontroId !== ids.encontros[dados.encontro]) throw conflito();
  }
}

async function carregarDemonstracaoOpcional(variaveis = process.env, conexaoOpcional) {
  const configuracao = carregarDemonstracao(variaveis); // Antes de conectar; nunca apara senhas.
  if (configuracao.dataBase) criarPlano(configuracao.dataBase);
  const conexao = conexaoOpcional ?? banco.obterConexao();
  try {
    const [preexistente] = await conexao.query('SELECT chave FROM cargas_demonstracao WHERE chave = $chave', {
      type: QueryTypes.SELECT, bind: { chave: CHAVE },
    });
    // bcrypt não mantém locks nem a conexão de uma transação por vários hashes.
    // A existência e os conflitos são revalidados sob a trava antes de gravar;
    // numa corrida, hashes calculados pela carga perdedora são apenas descartados.
    const hashes = preexistente ? null : Object.fromEntries(await Promise.all(Object.entries(configuracao.senhas)
      .map(async ([papel, senha]) => [papel, await bcrypt.hash(senha, 12)])));
    return await conexao.transaction(async (transaction) => {
      await conexao.query('SELECT pg_advisory_xact_lock(hashtext($chave))', { bind: { chave: 'leia+:demonstracao:v1' }, transaction });
      const [controle] = await conexao.query('SELECT data_base::text AS "dataBase", manifesto FROM cargas_demonstracao WHERE chave = $chave FOR UPDATE', {
        type: QueryTypes.SELECT, bind: { chave: CHAVE }, transaction,
      });
      const dataBase = configuracao.dataBase ?? controle?.dataBase ?? dataEmSaoPaulo();
      if (controle && controle.dataBase !== dataBase) throw conflito();
      const plano = criarPlano(dataBase);
      const ativo = await conexao.models.CicloLeitura.findOne({ where: { situacao: 'EM_ANDAMENTO' }, attributes: ['id'], transaction });
      if (ativo && ativo.id !== controle?.manifesto?.ids?.ciclos?.atual) throw conflito();
      if (controle) {
        await validarManifesto(controle.manifesto, plano, conexao, transaction);
        // Reexecução é leitura: não altera hash, nome, situação, versão, páginas,
        // conclusão ou datas. Ausências/conflitos não são "consertados" pela carga.
        return { criada: false, dataBase };
      }
      if (!hashes) throw conflito(); // Manifesto removido entre as duas leituras.
      const referencia = await conexao.query('SELECT name FROM sequelize_seeds WHERE name = $nome', {
        type: QueryTypes.SELECT, bind: { nome: '20261030061000-carregar-generos-referencia.js' }, transaction,
      });
      if (!referencia.length) throw conflito();
      for (const [modelo, campo, valores] of [
        ['Usuario', 'email', Object.values(plano.usuarios).map((dado) => dado.email)],
        ['Livro', 'titulo', Object.values(plano.livros).map((dado) => dado.titulo)],
        ['CicloLeitura', 'nome', Object.values(plano.ciclos).map((dado) => dado.nome)],
        ['Encontro', 'titulo', Object.values(plano.encontros).map((dado) => dado.titulo)],
      ]) if (await conexao.models[modelo].findOne({ where: { [campo]: { [Op.in]: valores } }, transaction })) throw conflito();
      const generos = {};
      for (const nome of new Set(Object.values(plano.livros).map((dado) => dado.genero))) {
        const genero = await conexao.models.Genero.findOne({ where: { nome }, transaction, lock: transaction.LOCK.KEY_SHARE });
        if (!genero) throw conflito(); generos[nome] = genero.id;
      }
      const ids = Object.fromEntries(Object.keys(grupos).map((grupo) => [grupo, {}]));
      for (const [chave, dados] of Object.entries(plano.usuarios)) {
        const senhaHash = hashes[chave];
        const usuario = await conexao.models.Usuario.create({ ...dados, perfil: 'LEITOR', sessionVersion: 0, senhaHash }, { transaction });
        ids.usuarios[chave] = usuario.id;
      }
      for (const [chave, { genero, ...dados }] of Object.entries(plano.livros)) ids.livros[chave] = (await conexao.models.Livro.create({ ...dados, generoId: generos[genero] }, { transaction })).id;
      for (const [chave, { livro, ...dados }] of Object.entries(plano.ciclos)) ids.ciclos[chave] = (await conexao.models.CicloLeitura.create({ ...dados, livroId: ids.livros[livro] }, { transaction })).id;
      for (const [chave, { ciclo, ...dados }] of Object.entries(plano.encontros)) ids.encontros[chave] = (await conexao.models.Encontro.create({ local: 'Biblioteca escolar (demo)', ...dados, cicloId: ids.ciclos[ciclo] }, { transaction })).id;
      for (const [chave, { usuario, ciclo, ...dados }] of Object.entries(plano.participacoes)) ids.participacoes[chave] = (await conexao.models.ParticipacaoLeitura.create({ ...dados, usuarioId: ids.usuarios[usuario], cicloId: ids.ciclos[ciclo] }, { transaction })).id;
      for (const [chave, dados] of Object.entries(plano.inscricoes)) ids.inscricoes[chave] = (await conexao.models.InscricaoEncontro.create({ usuarioId: ids.usuarios[dados.usuario], encontroId: ids.encontros[dados.encontro] }, { transaction })).id;
      await conexao.query('INSERT INTO cargas_demonstracao (chave, data_base, manifesto, criado_em) VALUES ($chave, $data, $manifesto::jsonb, CURRENT_TIMESTAMP)', {
        bind: { chave: CHAVE, data: dataBase, manifesto: JSON.stringify({ versao: 1, ids }) }, transaction,
      });
      return { criada: true, dataBase };
    });
  } catch (erro) {
    // O índice parcial arbitra também uma ativação administrativa concorrente.
    if (erro instanceof UniqueConstraintError) throw conflito();
    throw erro;
  }
}

async function executar() {
  try {
    const resultado = await carregarDemonstracaoOpcional();
    console.info(resultado.criada ? `Demonstração criada com data-base ${resultado.dataBase} (America/Sao_Paulo).` : `Demonstração já existente (${resultado.dataBase}); nenhum dado foi sobrescrito.`);
  } catch (erro) {
    console.error(['CONFIGURACAO_DEMONSTRACAO_INVALIDA', 'CONFLITO_DEMONSTRACAO'].includes(erro.codigo) ? erro.message : 'Não foi possível carregar a demonstração. Nenhuma credencial foi exibida.');
    process.exitCode = 1;
  } finally {
    try { await banco.encerrarConexao(); }
    catch { console.error('Não foi possível encerrar a conexão da demonstração.'); process.exitCode = 1; }
  }
}

if (require.main === module) executar();
module.exports = { carregarDemonstracaoOpcional };
