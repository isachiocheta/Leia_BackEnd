'use strict';

const bcrypt = require('bcrypt');
const { UniqueConstraintError } = require('sequelize');
const { carregarAdministrador } = require('../configuracao/administrador');
const banco = require('./conexao');

function conflitoAdministrativo() {
  const erro = new Error('Conflito de identidade ou perfil administrativo. Nenhuma conta foi alterada.');
  erro.codigo = 'CONFLITO_ADMINISTRADOR';
  return erro;
}

async function bootstrapAdministrativo(variaveis = process.env, conexaoOpcional) {
  // Credenciais inválidas não devem sequer abrir a conexão.
  const { nome, email, senha } = carregarAdministrador(variaveis);
  const conexao = conexaoOpcional ?? banco.obterConexao();
  const { Usuario } = conexao.models;

  try {
    return await conexao.transaction(async (transaction) => {
      // Serializa execuções deste bootstrap por email, mesmo antes de a conta
      // existir. A unicidade no banco também protege contra outros escritores.
      await conexao.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', {
        bind: ['leia+:bootstrap-administrativo', email], transaction,
      });
      const existente = await Usuario.findOne({
        where: { email },
        attributes: ['id', 'nome', 'perfil', 'situacao'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      if (existente) {
        // Reexecução aceita a mesma identidade administrativa ativa; não troca
        // nome, senha, situação ou versão, mesmo que outra senha seja informada.
        if (existente.nome.trim() !== nome || existente.perfil !== 'ADMIN_CLUBE' || existente.situacao !== 'ATIVO') {
          throw conflitoAdministrativo();
        }
        return { criado: false };
      }

      const senhaHash = await bcrypt.hash(senha, 12);
      await Usuario.create({
        nome, email, senhaHash,
        perfil: 'ADMIN_CLUBE', situacao: 'ATIVO', sessionVersion: 0,
      }, { transaction });
      return { criado: true };
    });
  } catch (erro) {
    // Uma criação concorrente externa ao bootstrap nunca autoriza promoção.
    if (erro instanceof UniqueConstraintError) throw conflitoAdministrativo();
    throw erro;
  }
}

async function executar() {
  try {
    const resultado = await bootstrapAdministrativo();
    console.info(resultado.criado
      ? 'Administrador criado.'
      : 'Administrador já existente. Nenhuma credencial foi alterada.');
  } catch (erro) {
    const codigosSeguros = ['CONFIGURACAO_ADMINISTRADOR_INVALIDA', 'CONFLITO_ADMINISTRADOR'];
    console.error(codigosSeguros.includes(erro.codigo)
      ? erro.message
      : 'Não foi possível concluir o bootstrap administrativo. Nenhuma credencial foi exibida.');
    process.exitCode = 1;
  } finally {
    try {
      await banco.encerrarConexao();
    } catch {
      console.error('Não foi possível encerrar as conexões PostgreSQL.');
      process.exitCode = 1;
    }
  }
}

if (require.main === module && !require('../utilitarios/ajuda').exibirAjuda('db:admin')) executar();

module.exports = { bootstrapAdministrativo };
