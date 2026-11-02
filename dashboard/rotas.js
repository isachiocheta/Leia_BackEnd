'use strict';

const express = require('express');
const { exigirAutenticacao, exigirPerfil } = require('../autenticacao/rotas');
const { responderDetalhe } = require('../utilitarios/respostas');
const { rejeitarCamposDesconhecidos, validarRequisicao } = require('../validacao/requisicao');
const { consultarDashboardAdmin } = require('../servicos/dashboard');

function criarRotasDashboard({ obterConexao, agora = Date.now }) {
  const roteador = express.Router();
  roteador.get('/admin', exigirAutenticacao, exigirPerfil('ADMIN_CLUBE'),
    rejeitarCamposDesconhecidos([], { local: 'query' }), validarRequisicao,
    async (requisicao, resposta) => {
      resposta.set('Cache-Control', 'no-store');
      responderDetalhe(resposta, await consultarDashboardAdmin(obterConexao(), { agora }));
    });
  return roteador;
}

module.exports = { criarRotasDashboard };
