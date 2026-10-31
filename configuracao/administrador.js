'use strict';

const { Validator } = require('sequelize');
const { senhaValida } = require('../utilitarios/senha');

function configuracaoInvalida(mensagem) {
  const erro = new Error(mensagem);
  erro.codigo = 'CONFIGURACAO_ADMINISTRADOR_INVALIDA';
  throw erro;
}

function carregarAdministrador(variaveis = process.env) {
  if (typeof variaveis.ADMIN_NOME !== 'string') {
    configuracaoInvalida('ADMIN_NOME é obrigatório.');
  }
  const nome = variaveis.ADMIN_NOME.trim();
  if (nome.length === 0 || Array.from(nome).length > 100) {
    configuracaoInvalida('ADMIN_NOME deve conter entre 1 e 100 caracteres.');
  }

  if (typeof variaveis.ADMIN_EMAIL !== 'string') {
    configuracaoInvalida('ADMIN_EMAIL é obrigatório.');
  }
  const email = variaveis.ADMIN_EMAIL.trim().toLowerCase();
  if (Array.from(email).length > 254 || !Validator.isEmail(email)) {
    configuracaoInvalida('ADMIN_EMAIL deve ser um email válido de até 254 caracteres.');
  }

  const senha = variaveis.ADMIN_SENHA;
  if (typeof senha !== 'string') {
    configuracaoInvalida('ADMIN_SENHA é obrigatória.');
  }
  // A senha é usada exatamente como recebida, inclusive espaços e Unicode.
  // Contamos caracteres Unicode no mínimo e bytes UTF-8 no limite do bcrypt.
  if (!senhaValida(senha)) {
    configuracaoInvalida('ADMIN_SENHA deve ter no mínimo 10 caracteres e no máximo 72 bytes UTF-8.');
  }

  return { nome, email, senha };
}

module.exports = { carregarAdministrador };
