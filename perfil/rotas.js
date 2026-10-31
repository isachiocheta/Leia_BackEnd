'use strict';

const express = require('express');
const { body } = require('express-validator');
const { protegerRota } = require('../autenticacao/rotas');
const { encerrarSessaoAposTrocaSenha } = require('../autenticacao/encerramento-sessao');
const { alterarNome, alterarSenha } = require('../servicos/perfil');
const { senhaValida } = require('../utilitarios/senha');
const { responderDetalhe } = require('../utilitarios/respostas');
const {
  rejeitarCamposDesconhecidos, rejeitarPatchVazio, validarRequisicao, selecionarCamposPermitidos,
} = require('../validacao/requisicao');

function criarRotasPerfil({ obterUsuario }) {
  const roteador = express.Router();
  roteador.use(...protegerRota('ADMIN_CLUBE', 'LEITOR'));
  roteador.patch('/',
    rejeitarCamposDesconhecidos(['nome']),
    rejeitarPatchVazio(['nome']),
    body('nome').isString().bail().trim().custom((nome) => Array.from(nome).length >= 2 && Array.from(nome).length <= 100),
    validarRequisicao,
    async (requisicao, resposta) => {
      const { nome } = selecionarCamposPermitidos(requisicao, ['nome']);
      responderDetalhe(resposta, await alterarNome(requisicao.user, nome, obterUsuario()));
    });
  roteador.patch('/senha',
    rejeitarCamposDesconhecidos(['senhaAtual', 'novaSenha']),
    rejeitarPatchVazio(['senhaAtual', 'novaSenha']),
    body('senhaAtual').custom((senha) => typeof senha === 'string' && senha.length > 0 && Buffer.byteLength(senha, 'utf8') <= 72),
    body('novaSenha').custom(senhaValida),
    validarRequisicao,
    async (requisicao, resposta) => {
      const dados = selecionarCamposPermitidos(requisicao, ['senhaAtual', 'novaSenha']);
      const resultado = await alterarSenha(requisicao.user, dados, obterUsuario());
      await encerrarSessaoAposTrocaSenha(requisicao, resposta);
      responderDetalhe(resposta, resultado);
    });
  return roteador;
}

module.exports = { criarRotasPerfil };
