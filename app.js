'use strict';

const express = require('express');
const { carregarAmbiente } = require('./configuracao/ambiente');
const { configurarHttp } = require('./intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('./intermediarios/erros');
const { ErroAplicacao } = require('./utilitarios/erro-aplicacao');
const { responderDetalhe } = require('./utilitarios/respostas');
const banco = require('./database/conexao');

const configuracao = carregarAmbiente();
const app = express();

app.set('env', configuracao.ambiente);
configurarHttp(app, configuracao);

app.get('/api/health', (requisicao, resposta) => {
  responderDetalhe(resposta, { aplicacao: 'Leia+', status: 'ok' });
});

app.get('/api/ready', async (requisicao, resposta, proximo) => {
  resposta.set('Cache-Control', 'no-store');

  try {
    await banco.verificarConexao();
    responderDetalhe(resposta, { aplicacao: 'Leia+', status: 'pronto' });
  } catch {
    proximo(new ErroAplicacao('SERVICE_UNAVAILABLE'));
  }
});

app.use(rotaNaoEncontrada);
app.use(tratarErros);

module.exports = app;
